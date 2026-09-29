/**
 * Customer notifications (WhatsApp) behind one seam. OWNER: B6 (notifications).
 * Keep the exported signatures; replace the bodies.
 *
 * Every business message goes through enqueueMessage → the outbox → drainOutbox
 * (tick). WHATSAPP_PROVIDER=log (default outside production) records the message as
 * status 'logged' and sends nothing — there is no path where credentials being
 * present silently turns tests into real sends without WHATSAPP_PROVIDER being set.
 */

import type { OpCtx } from '../clock';

/** Every template the platform can send. Copy lives in lib/notify/templates.ts (EN + TE). */
export type TemplateName =
  | 'order_confirmed'
  | 'first_delivery_tomorrow'
  | 'delivered_today'
  | 'not_delivered_ours'
  | 'not_delivered_customer'
  | 'pause_confirmed'
  | 'cancellation_confirmed'
  | 'refund_processed'
  | 'refund_needs_upi'
  | 'renewal_reminder'
  | 'extra_confirmed'
  | 'disruption_notice'
  | 'ticket_update';

export interface NewMessage {
  mobile: string;
  template: TemplateName;
  /** template variables, already formatted for humans ("₹2,850", "Thu 2 Oct") */
  params: Record<string, string>;
  /** unique per business fact — the same fact is never messaged twice */
  dedupeKey: string;
  /** optional image header (e.g. the doorstep photo), absolute URL */
  mediaUrl?: string;
}

/** Queue a message. Respects opt-in and language. NEVER throws — a failed notification must not fail the business action. */
export async function enqueueMessage(msg: NewMessage, ctx: OpCtx): Promise<void> {
  void msg;
  void ctx;
  // eslint-disable-next-line no-console
  console.warn('[notify] enqueueMessage not implemented yet (owner B6)', msg.template);
}

/** Tick step: send queued messages with retry/backoff. */
export async function drainOutbox(ctx: OpCtx): Promise<{ sent: number; failed: number; logged: number }> {
  void ctx;
  throw new Error('not implemented: drainOutbox (owner B6)');
}

/** Tick step: renewal reminders N days before endDate (settings.renewalReminderDays), once each. */
export async function enqueueRenewalReminders(ctx: OpCtx): Promise<{ queued: number }> {
  void ctx;
  throw new Error('not implemented: enqueueRenewalReminders (owner B6)');
}

/**
 * Send a sign-in code over WhatsApp (authentication template) synchronously.
 * 'not_configured' → lib/auth falls back to its dev/demo behaviour.
 */
export async function sendAuthCode(mobile: string, code: string): Promise<'sent' | 'not_configured'> {
  void mobile;
  void code;
  return 'not_configured';
}
