/**
 * Inbound customer WhatsApp messages, whichever provider delivered them. OWNER: B6.
 *
 * Both webhooks (Meta's Cloud API and AiSensy) normalise a message into an
 * InboundInput and hand it here, so a STOP or a "Report a problem" tap means the
 * same thing however it arrived:
 *
 *   STOP / UNSUBSCRIBE     → WhatsApp updates turned off for that customer
 *   REPORT_ISSUE           → a ticket for staff (channel whatsapp)
 *   TALK                   → flagged for a human
 *   PAUSE_TOMORROW         → noted only: pausing has cut-off and allowance rules the
 *                            customer must see, so it is never done from a reply
 *   a shared location      → a ticket noting the coordinates for ops
 *
 * Idempotent on providerMessageId: providers re-deliver, and a duplicate is a no-op.
 */

import { getDb } from '../db';
import { col, normalizeMobile, type InboundMessage, type LatLng } from '../models';
import { systemCtx } from '../clock';
import { recordEvent } from '../events';
import { createTicket } from '../tickets';
import { setWhatsappOptIn } from './optin';

export interface InboundInput {
  providerMessageId: string;
  /** the sender's number as the provider gives it (91XXXXXXXXXX, +91…, or 10 digits) */
  from: string;
  type: InboundMessage['type'];
  /** the message text, when there is one */
  text?: string;
  /** a button or list-reply payload/id, when the customer tapped one */
  payload?: string;
  location?: LatLng;
  receivedAt: Date;
  /** which webhook it came through, for the event log */
  source: 'whatsapp_webhook' | 'aisensy_webhook';
}

export type Intent = 'STOP' | 'REPORT_ISSUE' | 'TALK' | 'PAUSE_TOMORROW';

/** The button/text intents we understand. Case-insensitive on a payload or the text. */
export function intentOf(raw: string | undefined): Intent | null {
  const t = (raw ?? '').trim().toUpperCase();
  if (!t) return null;
  if (t === 'STOP' || t === 'UNSUBSCRIBE') return 'STOP';
  if (t === 'REPORT_ISSUE' || t === 'REPORT ISSUE' || t === 'REPORT A PROBLEM') return 'REPORT_ISSUE';
  if (t === 'TALK' || t === 'TALK TO US') return 'TALK';
  if (t === 'PAUSE_TOMORROW' || t === 'PAUSE TOMORROW') return 'PAUSE_TOMORROW';
  return null;
}

/**
 * Record an inbound message once and act on it. Returns 'duplicate' when this
 * providerMessageId was already recorded, else how it was handled (or null when it
 * was stored for staff to read but needed no action).
 */
export async function recordInbound(input: InboundInput): Promise<'duplicate' | string | null> {
  if (!input.providerMessageId || !input.from) return null;
  const mobile = normalizeMobile(input.from) ?? input.from.replace(/\D/g, '');
  const db = await getDb();

  // A tapped button's payload wins over its visible text.
  const intent = intentOf(input.payload) ?? intentOf(input.text);

  const doc: InboundMessage = {
    providerMessageId: input.providerMessageId,
    from: mobile,
    type: input.type,
    ...(input.text ? { text: input.text } : {}),
    ...(intent ? { payload: intent } : {}),
    ...(input.location ? { location: input.location } : {}),
    receivedAt: input.receivedAt,
    handled: false,
  };

  try {
    await col.inbound(db).insertOne(doc);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return 'duplicate';
    throw err;
  }

  const ctx = systemCtx(input.receivedAt, input.source);
  let handledAs: string | null = null;

  if (intent === 'STOP') {
    await setWhatsappOptIn(mobile, false, 'whatsapp_stop', ctx);
    handledAs = 'opt_out';
  } else if (intent === 'REPORT_ISSUE') {
    await createTicket({ mobile, kind: 'other', channel: 'whatsapp', note: 'Customer reported an issue via WhatsApp.' }, ctx);
    handledAs = 'ticket';
  } else if (intent === 'TALK') {
    handledAs = 'human';
  } else if (intent === 'PAUSE_TOMORROW') {
    handledAs = 'reply_link:/account';
  } else if (doc.location) {
    await createTicket(
      { mobile, kind: 'other', channel: 'whatsapp', note: `Location shared via WhatsApp for ops: ${doc.location.lat},${doc.location.lng}` },
      ctx,
    );
    handledAs = 'location_ticket';
  }

  if (handledAs) {
    await col.inbound(db).updateOne({ providerMessageId: input.providerMessageId }, { $set: { handled: true, handledAs } });
    await recordEvent(
      ctx,
      {
        entity: 'message',
        entityId: input.providerMessageId,
        type: 'message.inbound',
        mobile,
        data: { handledAs, intent: intent ?? null, via: input.source },
      },
      db,
    );
  }
  return handledAs;
}
