/**
 * AiSensy webhook: signature check and payload parsing. PURE (no DB, no env) so it
 * is unit-tested directly. OWNER: B6. The route is app/api/webhooks/aisensy.
 *
 * From AiSensy's webhook docs (aisensy.stoplight.io → Project API → Project Webhook):
 *  · POST, JSON, signed: X-AiSensy-Signature = hex(HMAC-SHA256(body, shared secret)).
 *    AiSensy's own Node sample signs JSON.stringify(parsedBody); for a compact body
 *    that is the raw body byte for byte. Both are accepted — each needs the secret.
 *  · body: { id, created_at (ms), topic, delivery_attempt, project_id, data }
 *  · topics used here:
 *      message.status.updated              → data.message: a delivery receipt
 *      contact.campaign.{sent,delivered,read} → the same, for campaign messages
 *      message.sender.user                 → data.message: the customer wrote to us
 *  · message object: { id, messageId, phone_number, campaign: { name }, status,
 *    message_type, message_content, sent_at, delivered_at, read_at, failed_at,
 *    failureResponse: { code, reason } }
 *  · "Current implementation of webhooks is in beta" — so every field is read
 *    defensively, and an unknown shape is IGNORED, never thrown on.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundMessage, LatLng } from '../models';
import type { InboundInput } from './inbound';

/* ------------------------------------------------------------ signature -- */

function hmacHex(text: string, secret: string): string {
  return createHmac('sha256', secret).update(text, 'utf8').digest('hex');
}

function sameHex(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** True when X-AiSensy-Signature matches the raw body (or its compact re-serialisation). */
export function aisensySignatureValid(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const provided = header.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) return false;
  if (sameHex(provided, hmacHex(rawBody, secret))) return true;
  try {
    const compact = JSON.stringify(JSON.parse(rawBody));
    return compact !== rawBody && sameHex(provided, hmacHex(compact, secret));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- parsing -- */

export type ReceiptStatus = 'sent' | 'delivered' | 'read' | 'failed';

export type AisensyEvent =
  | {
      kind: 'status';
      /** candidate message ids, most specific first */
      ids: string[];
      mobile: string;
      /** the campaign it was sent under — the fallback match key */
      campaign?: string;
      status: ReceiptStatus;
      at: Date;
      error?: string;
    }
  | { kind: 'inbound'; input: Omit<InboundInput, 'source'> }
  | { kind: 'ignored'; topic: string; why: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

/** A timestamp in ms or s (number or numeric string) or an ISO string → Date. */
export function toDate(v: unknown, fallback: Date): Date {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return new Date(n > 1e12 ? n : n * 1000);
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t) : fallback;
  }
  return fallback;
}

const STATUS_WORDS: Record<string, ReceiptStatus> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  seen: 'read',
  failed: 'failed',
  undelivered: 'failed',
};

const AT_FIELD: Record<ReceiptStatus, string> = {
  sent: 'sent_at',
  delivered: 'delivered_at',
  read: 'read_at',
  failed: 'failed_at',
};

function inboundType(t: string | undefined): InboundMessage['type'] {
  switch ((t ?? '').toUpperCase()) {
    case 'TEXT':
      return 'text';
    case 'BUTTON':
      return 'button';
    case 'INTERACTIVE':
    case 'LIST':
      return 'interactive';
    case 'LOCATION':
      return 'location';
    case 'IMAGE':
      return 'image';
    default:
      return 'other';
  }
}

/** The text of an inbound message, wherever this content shape keeps it. */
function contentText(c: Obj | undefined): string | undefined {
  if (!c) return undefined;
  return (
    str(c.text) ??
    str(obj(c.text)?.body) ??
    str(c.body) ??
    str(obj(c.button)?.text) ??
    str(obj(obj(c.interactive)?.button_reply)?.title) ??
    str(obj(c.button_reply)?.title) ??
    str(c.caption)
  );
}

/** A tapped button / list reply's payload or id. */
function contentPayload(c: Obj | undefined): string | undefined {
  if (!c) return undefined;
  const interactive = obj(c.interactive);
  return (
    str(obj(c.button)?.payload) ??
    str(c.payload) ??
    str(obj(interactive?.button_reply)?.id) ??
    str(obj(interactive?.list_reply)?.id) ??
    str(obj(c.button_reply)?.id) ??
    str(obj(c.list_reply)?.id)
  );
}

function contentLocation(c: Obj | undefined): LatLng | undefined {
  const l = obj(c?.location) ?? c;
  const lat = Number(l?.latitude ?? l?.lat);
  const lng = Number(l?.longitude ?? l?.lng ?? l?.long);
  return l && Number.isFinite(lat) && Number.isFinite(lng) && (l.latitude !== undefined || l.lat !== undefined)
    ? { lat, lng }
    : undefined;
}

/** Turn one webhook notification into the one thing it means to us. Never throws. */
export function parseAisensyNotification(body: unknown, now = new Date()): AisensyEvent {
  const n = obj(body);
  const topic = str(n?.topic) ?? '';
  const message = obj(obj(n?.data)?.message);
  const created = toDate(n?.created_at, now);
  if (!message) return { kind: 'ignored', topic, why: 'no data.message' };

  const mobile = str(message.phone_number) ?? '';

  if (topic === 'message.status.updated' || topic.startsWith('contact.campaign.')) {
    const word = (str(message.status) ?? topic.slice('contact.campaign.'.length)).toLowerCase();
    const status = STATUS_WORDS[word];
    if (!status) return { kind: 'ignored', topic, why: `status "${word}" not tracked` };
    if (!mobile) return { kind: 'ignored', topic, why: 'no phone_number' };
    const failure = obj(message.failureResponse);
    const error = status === 'failed' ? (str(failure?.reason) ?? str(failure?.code) ?? 'failed') : undefined;
    const ids = [str(message.messageId), str(message.id)].filter((x): x is string => !!x);
    const campaign = str(obj(message.campaign)?.name);
    return {
      kind: 'status',
      ids,
      mobile,
      ...(campaign ? { campaign } : {}),
      status,
      at: toDate(message[AT_FIELD[status]], created),
      ...(error ? { error: `AiSensy: ${error}` } : {}),
    };
  }

  if (topic === 'message.sender.user') {
    if (!mobile) return { kind: 'ignored', topic, why: 'no phone_number' };
    const content = obj(message.message_content);
    const providerMessageId = str(message.messageId) ?? str(message.id) ?? str(n?.id);
    if (!providerMessageId) return { kind: 'ignored', topic, why: 'no message id' };
    const type = inboundType(str(message.message_type));
    const text = contentText(content) ?? (typeof message.message_content === 'string' ? str(message.message_content) : undefined);
    const payload = contentPayload(content);
    const location = contentLocation(content);
    return {
      kind: 'inbound',
      input: {
        providerMessageId,
        from: mobile,
        type: location && type === 'other' ? 'location' : type,
        ...(text ? { text } : {}),
        ...(payload ? { payload } : {}),
        ...(location ? { location } : {}),
        receivedAt: toDate(message.sent_at ?? message.created_at, created),
      },
    };
  }

  return { kind: 'ignored', topic, why: 'topic not handled' };
}
