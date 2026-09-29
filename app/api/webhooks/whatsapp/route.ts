/**
 * WhatsApp Cloud API webhook. OWNER: B6.
 *
 *   GET  — Meta's subscription handshake: echo hub.challenge iff
 *          hub.mode=subscribe AND hub.verify_token === WHATSAPP_VERIFY_TOKEN.
 *   POST — an event batch. The X-Hub-Signature-256 header (HMAC-SHA256 of the RAW
 *          body with WHATSAPP_APP_SECRET) is verified with a timing-safe comparison
 *          BEFORE the body is parsed — an unverified webhook is a spoofing hole.
 *
 * Two kinds of payload matter:
 *   · statuses[]  — delivery receipts (sent/delivered/read/failed) keyed by our
 *                   providerMessageId. Applied without moving a message backwards.
 *   · messages[]  — inbound customer messages, recorded idempotently on
 *                   providerMessageId, then routed:
 *                     STOP / unsubscribe        → opt out
 *                     REPORT_ISSUE              → open a ticket (channel whatsapp)
 *                     TALK                      → flag for a human
 *                     PAUSE_TOMORROW            → reply-with-link only (no mutation)
 *                     a location message        → a ticket noting the coordinates
 *
 * We always answer 200 to a signature-valid POST (even for content we ignore) so
 * Meta does not retry a batch we have already durably recorded.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { col, normalizeMobile, type InboundMessage } from '@/lib/models';
import { applyStatusReceipt } from '@/lib/notify';
import { setWhatsappOptIn } from '@/lib/notify/optin';
import { createTicket } from '@/lib/tickets';
import { systemCtx } from '@/lib/clock';
import { recordEvent } from '@/lib/events';

export const dynamic = 'force-dynamic';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** GET: subscription verification handshake. */
export async function GET(req: Request): Promise<NextResponse | Response> {
  const url = new URL(req.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expected = env('WHATSAPP_VERIFY_TOKEN');

  if (mode === 'subscribe' && expected && token === expected && challenge !== null) {
    // Meta expects the raw challenge string, not JSON.
    return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  return new Response('forbidden', { status: 403 });
}

/** Timing-safe compare of the provided signature against HMAC-SHA256(rawBody). */
function signatureValid(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header) return false;
  const provided = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<NextResponse> {
  const appSecret = env('WHATSAPP_APP_SECRET');
  if (!appSecret) {
    // Not configured: refuse rather than accept unverifiable events.
    return NextResponse.json({ error: 'WhatsApp webhook not configured', missing: ['WHATSAPP_APP_SECRET'] }, { status: 503 });
  }

  // RAW body FIRST — the signature is over the exact bytes, so we must not JSON.parse
  // (and re-serialise) before verifying.
  const rawBody = await req.text();
  const sig = req.headers.get('x-hub-signature-256');
  if (!signatureValid(rawBody, sig, appSecret)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  try {
    await handleEvents(payload);
  } catch (err) {
    // We recorded what we could; a handler error must not make Meta hammer us with
    // retries of a batch we have durably stored. Log and 200.
    // eslint-disable-next-line no-console
    console.error('[whatsapp:webhook] handler error', err instanceof Error ? err.message : err);
  }
  return NextResponse.json({ ok: true });
}

/* ---------------------------------------------------------------- routing -- */

interface WaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: { title?: string }[];
}
interface WaMessage {
  id?: string;
  from?: string;
  type?: string;
  timestamp?: string;
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
  location?: { latitude?: number; longitude?: number };
}

function tsToDate(ts: string | undefined): Date {
  const n = ts ? Number(ts) : NaN;
  return Number.isFinite(n) ? new Date(n * 1000) : new Date();
}

async function handleEvents(payload: unknown): Promise<void> {
  const entries = readArray(payload, 'entry');
  for (const entry of entries) {
    for (const change of readArray(entry, 'changes')) {
      const value = (change as { value?: unknown }).value;
      if (!value || typeof value !== 'object') continue;
      for (const s of readArray(value, 'statuses')) await handleStatus(s as WaStatus);
      for (const m of readArray(value, 'messages')) await handleInbound(m as WaMessage);
    }
  }
}

function readArray(obj: unknown, key: string): unknown[] {
  if (obj && typeof obj === 'object' && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

const STATUS_MAP: Record<string, 'sent' | 'delivered' | 'read' | 'failed'> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

async function handleStatus(s: WaStatus): Promise<void> {
  if (!s.id || !s.status) return;
  const mapped = STATUS_MAP[s.status];
  if (!mapped) return;
  const db = await getDb();
  const error = mapped === 'failed' ? s.errors?.[0]?.title : undefined;
  await applyStatusReceipt(s.id, mapped, tsToDate(s.timestamp), db, error);
}

/** The button/text intents we understand. Case-insensitive match on payload or body. */
function intentOf(m: WaMessage): string | null {
  const raw =
    m.button?.payload ??
    m.interactive?.button_reply?.id ??
    m.interactive?.list_reply?.id ??
    m.text?.body ??
    '';
  const t = raw.trim().toUpperCase();
  if (!t) return null;
  if (t === 'STOP' || t === 'UNSUBSCRIBE') return 'STOP';
  if (t === 'REPORT_ISSUE' || t === 'REPORT ISSUE') return 'REPORT_ISSUE';
  if (t === 'TALK') return 'TALK';
  if (t === 'PAUSE_TOMORROW' || t === 'PAUSE TOMORROW') return 'PAUSE_TOMORROW';
  return null;
}

async function handleInbound(m: WaMessage): Promise<void> {
  if (!m.id || !m.from) return;
  const mobile = normalizeMobile(m.from) ?? m.from.replace(/\D/g, '');
  const receivedAt = tsToDate(m.timestamp);
  const db = await getDb();

  const type = mapType(m.type);
  const intent = intentOf(m);

  const doc: InboundMessage = {
    providerMessageId: m.id,
    from: mobile,
    type,
    ...(m.text?.body ? { text: m.text.body } : {}),
    ...(intent ? { payload: intent } : {}),
    ...(m.location && typeof m.location.latitude === 'number' && typeof m.location.longitude === 'number'
      ? { location: { lat: m.location.latitude, lng: m.location.longitude } }
      : {}),
    receivedAt,
    handled: false,
  };

  // Idempotent on providerMessageId — Meta re-delivers. A duplicate is a no-op.
  try {
    await col.inbound(db).insertOne(doc);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return; // already processed
    throw err;
  }

  const ctx = systemCtx(receivedAt, 'whatsapp_webhook');
  let handledAs: string | undefined;

  if (intent === 'STOP') {
    await setWhatsappOptIn(mobile, false, 'whatsapp_stop', ctx);
    handledAs = 'opt_out';
  } else if (intent === 'REPORT_ISSUE') {
    await createTicket(
      { mobile, kind: 'other', channel: 'whatsapp', note: 'Customer reported an issue via WhatsApp.' },
      ctx,
    );
    handledAs = 'ticket';
  } else if (intent === 'TALK') {
    handledAs = 'human';
  } else if (intent === 'PAUSE_TOMORROW') {
    // No mutation from the webhook — pausing has cutoff/allowance rules the customer
    // must see. We only note that a link should be sent back to /account.
    handledAs = 'reply_link:/account';
  } else if (doc.location) {
    await createTicket(
      {
        mobile,
        kind: 'other',
        channel: 'whatsapp',
        note: `Location shared via WhatsApp for ops: ${doc.location.lat},${doc.location.lng}`,
      },
      ctx,
    );
    handledAs = 'location_ticket';
  }

  if (handledAs) {
    await col.inbound(db).updateOne({ providerMessageId: m.id }, { $set: { handled: true, handledAs } });
    await recordEvent(
      ctx,
      {
        entity: 'message',
        entityId: m.id,
        type: 'message.inbound',
        mobile,
        data: { handledAs, intent: intent ?? null },
      },
      db,
    );
  }
}

function mapType(t: string | undefined): InboundMessage['type'] {
  switch (t) {
    case 'text':
      return 'text';
    case 'button':
      return 'button';
    case 'interactive':
      return 'interactive';
    case 'location':
      return 'location';
    case 'image':
      return 'image';
    default:
      return 'other';
  }
}
