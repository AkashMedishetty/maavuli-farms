/**
 * AiSensy webhook. OWNER: B6.
 *
 * Configure in AiSensy: dashboard → Manage → Webhooks (Developer) → URL
 *   https://<site>/api/webhooks/aisensy
 * with a shared secret (= AISENSY_WEBHOOK_SECRET here) and the topics
 *   message.status.updated, message.sender.user
 * (contact.campaign.sent / delivered / read are understood too, if subscribed).
 *
 *   POST — X-AiSensy-Signature (HMAC-SHA256 of the raw body) is verified BEFORE the
 *          body is parsed; an unverified webhook is a spoofing hole. Then:
 *            · a delivery receipt advances the matching outbox row (by message id,
 *              else by mobile + campaign — see applyReceiptWithFallback), never
 *              backwards;
 *            · a customer message goes through lib/notify/inbound (STOP turns updates
 *              off, "Report a problem" opens a ticket, and so on).
 *          Anything else is acknowledged and ignored.
 *   GET  — a plain "alive" answer, for checking the URL in a browser. Reveals nothing.
 *
 * Answers: 2xx once handled (AiSensy expects one within 5 s), 401 on a bad
 * signature, 503 when the secret is not configured, 500 when storing failed — AiSensy
 * then retries once after 5 minutes, which is safe because handling is idempotent.
 */

import { NextResponse } from 'next/server';
import { applyReceiptWithFallback } from '@/lib/notify';
import { recordInbound } from '@/lib/notify/inbound';
import { aisensySignatureValid, parseAisensyNotification } from '@/lib/notify/aisensy-webhook';

export const dynamic = 'force-dynamic';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, webhook: 'aisensy' });
}

export async function POST(req: Request): Promise<NextResponse> {
  const secret = env('AISENSY_WEBHOOK_SECRET');
  if (!secret) {
    return NextResponse.json({ error: 'AiSensy webhook not configured', missing: ['AISENSY_WEBHOOK_SECRET'] }, { status: 503 });
  }

  // RAW body first: the signature is over the exact bytes.
  const rawBody = await req.text();
  if (!aisensySignatureValid(rawBody, req.headers.get('x-aisensy-signature'), secret)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }

  // Optional pin to our own AiSensy project, when its id is configured.
  const project = env('AISENSY_PROJECT_ID');
  const sentProject = req.headers.get('x-aisensy-project-id');
  if (project && sentProject && sentProject !== project) {
    return NextResponse.json({ error: 'wrong project' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const event = parseAisensyNotification(body);
  try {
    if (event.kind === 'status') {
      await applyReceiptWithFallback({
        ids: event.ids,
        mobile: event.mobile,
        ...(event.campaign ? { providerRef: event.campaign } : {}),
        status: event.status,
        at: event.at,
        ...(event.error ? { error: event.error } : {}),
      });
    } else if (event.kind === 'inbound') {
      await recordInbound({ ...event.input, source: 'aisensy_webhook' });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[aisensy:webhook] handler error', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'could not store' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, handled: event.kind });
}
