/**
 * Customer notifications (WhatsApp) behind one seam. OWNER: B6 (notifications).
 *
 * Every business message goes through enqueueMessage → the outbox → drainOutbox
 * (tick). WHATSAPP_PROVIDER=log (default outside production) records the message as
 * status 'logged' and sends nothing — there is no path where credentials being
 * present silently turns tests into real sends without WHATSAPP_PROVIDER being set.
 *
 * Invariants:
 *  · enqueueMessage NEVER throws — a failed notification must not fail the business
 *    action that triggered it. A duplicate dedupeKey is swallowed (the fact was
 *    already messaged). A customer without whatsappOptIn is recorded 'suppressed'.
 *  · drainOutbox is idempotent-safe under concurrent ticks: it claims each row with
 *    a conditional update before sending, so two ticks never send the same message.
 *  · the webhook advances a message's status by providerMessageId and NEVER moves it
 *    backwards (see rankStatus) — a 'read' receipt must not be undone by a late
 *    'delivered'.
 */

import type { Db } from 'mongodb';
import { getDb } from '../db';
import { col, normalizeMobile, type Lang, type MessageStatus, type OutboundMessage } from '../models';
import { getOpsSettings } from '../settings';
import { addDaysYMD, istYMD } from '../cutoff';
import { recordEvent } from '../events';
import { resolveProvider } from './providers';
import { render } from './templates';
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

/**
 * Retry backoff, in minutes, indexed by the attempt that just FAILED (1-based).
 * attempt 1 failed → wait 1m, 2 → 5m, 3 → 30m, 4 → 2h, 5 → 6h. After a 5th failure
 * (MAX_ATTEMPTS) the message is marked 'failed' and no longer retried.
 */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 360] as const;
export const MAX_ATTEMPTS = 5;
const DRAIN_BATCH = 50;

/** When to next try, given the attempt count that just failed. null = give up. */
export function nextAttemptAt(attemptsSoFar: number, from: Date): Date | null {
  if (attemptsSoFar >= MAX_ATTEMPTS) return null;
  const mins = BACKOFF_MINUTES[attemptsSoFar - 1] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1] ?? 1;
  return new Date(from.getTime() + mins * 60_000);
}

/**
 * Status ordering, so a status update never moves a message backwards. queued and
 * the terminal-ish delivery states are ranked; 'logged' and 'suppressed' are
 * outcomes of the log driver / opt-out and are treated as terminal for the webhook
 * (a webhook receipt should never touch a logged message).
 */
const STATUS_RANK: Record<MessageStatus, number> = {
  queued: 0,
  suppressed: 1,
  logged: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 2, // a failure ranks like 'sent' — a later delivered/read may still supersede it
};

export function outranks(next: MessageStatus, current: MessageStatus): boolean {
  return STATUS_RANK[next] > STATUS_RANK[current];
}

/**
 * Queue a message. Respects opt-in and language. NEVER throws — a failed
 * notification must not fail the business action.
 */
export async function enqueueMessage(msg: NewMessage, ctx: OpCtx): Promise<void> {
  try {
    const normalized = normalizeMobile(msg.mobile);
    if (!normalized) return;

    const db = await getDb();
    const user = await col.users(db).findOne({ mobile: normalized });
    const lang: Lang = user?.lang ?? 'en';

    // A customer who has not opted in is recorded 'suppressed' — we keep the row so
    // the admin can see the message was intended, but nothing is ever sent.
    const optedIn = user?.whatsappOptIn === true;
    const status: MessageStatus = optedIn ? 'queued' : 'suppressed';

    const now = ctx.now;
    const doc: OutboundMessage = {
      mobile: normalized,
      template: msg.template,
      lang,
      params: msg.params,
      ...(msg.mediaUrl ? { mediaUrl: msg.mediaUrl } : {}),
      dedupeKey: msg.dedupeKey,
      status,
      attempts: 0,
      ...(status === 'queued' ? { nextAttemptAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    };

    try {
      await col.outbox(db).insertOne(doc);
    } catch (err) {
      // duplicate dedupeKey → the fact was already messaged; that is success, not an error
      if (isDuplicateKey(err)) return;
      throw err;
    }

    await recordEvent(
      ctx,
      {
        entity: 'message',
        entityId: msg.dedupeKey,
        type: 'message.queued',
        mobile: normalized,
        to: status,
        data: { template: msg.template },
      },
      db,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notify] enqueueMessage failed (swallowed)', msg.template, err instanceof Error ? err.message : err);
  }
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** Tick step: send queued messages with retry/backoff. */
export async function drainOutbox(ctx: OpCtx): Promise<{ sent: number; failed: number; logged: number }> {
  const db = await getDb();
  const outbox = col.outbox(db);
  const now = ctx.now;
  let provider;
  try {
    provider = resolveProvider();
  } catch {
    // production with WHATSAPP_PROVIDER unset — leave everything queued
    return { sent: 0, failed: 0, logged: 0 };
  }

  const due = await outbox
    .find({ status: 'queued', nextAttemptAt: { $lte: now } })
    .sort({ nextAttemptAt: 1 })
    .limit(DRAIN_BATCH)
    .toArray();

  let sent = 0;
  let failed = 0;
  let logged = 0;

  for (const msg of due) {
    if (!msg._id) continue;

    // Claim the row so a concurrent tick cannot also send it. We bump attempts and
    // push nextAttemptAt out of the way; a success/failure below rewrites the row.
    const claim = await outbox.updateOne(
      { _id: msg._id, status: 'queued' },
      { $set: { updatedAt: now }, $inc: { attempts: 1 } },
    );
    if (claim.matchedCount === 0) continue; // another tick took it

    const attempts = msg.attempts + 1;
    const result = await provider.send({
      mobile: msg.mobile,
      template: msg.template as NewMessage['template'],
      lang: msg.lang,
      params: msg.params,
      ...(msg.mediaUrl ? { mediaUrl: msg.mediaUrl } : {}),
    });

    if (result.ok) {
      const status: MessageStatus = result.status === 'logged' ? 'logged' : 'sent';
      await outbox.updateOne(
        { _id: msg._id },
        {
          $set: {
            status,
            provider: provider.name,
            providerMessageId: result.providerMessageId,
            updatedAt: now,
          },
          $unset: { nextAttemptAt: '', error: '' },
        },
      );
      if (status === 'logged') logged++;
      else sent++;
      continue;
    }

    // failure — decide retry vs give up
    const retryAt = result.retryable ? nextAttemptAt(attempts, now) : null;
    if (retryAt) {
      await outbox.updateOne(
        { _id: msg._id },
        { $set: { status: 'queued', nextAttemptAt: retryAt, error: result.error, updatedAt: now } },
      );
      // still queued — not counted as failed yet
    } else {
      await outbox.updateOne(
        { _id: msg._id },
        { $set: { status: 'failed', error: result.error, updatedAt: now }, $unset: { nextAttemptAt: '' } },
      );
      failed++;
      await recordEvent(
        ctx,
        {
          entity: 'message',
          entityId: msg.dedupeKey,
          type: 'message.failed',
          mobile: msg.mobile,
          from: 'queued',
          to: 'failed',
          reason: result.error,
        },
        db,
      );
    }
  }

  return { sent, failed, logged };
}

/**
 * Tick step: renewal reminders N days before endDate (settings.renewalReminderDays),
 * once each. A subscription that already has a renewal queued (renewedBy set) is
 * skipped — the customer has renewed, so nagging them is wrong. dedupeKey carries
 * daysLeft so each of [7,3,1] fires exactly once.
 */
export async function enqueueRenewalReminders(ctx: OpCtx): Promise<{ queued: number }> {
  const db = await getDb();
  const settings = await getOpsSettings(db);
  const today = istYMD(ctx.now);

  let queued = 0;
  for (const daysLeft of settings.renewalReminderDays) {
    const targetEnd = addDaysYMD(today, daysLeft);
    const subs = await col
      .subscriptions(db)
      .find({ status: 'active', endDate: targetEnd, renewedBy: { $exists: false } })
      .toArray();

    for (const sub of subs) {
      if (!sub._id) continue;
      await enqueueMessage(
        {
          mobile: sub.mobile,
          template: 'renewal_reminder',
          params: {
            daysLeft: String(daysLeft),
            endDate: sub.endDate,
            link: '/account',
          },
          dedupeKey: `renewal:${sub._id.toHexString()}:${daysLeft}`,
        },
        ctx,
      );
      queued++;
    }
  }
  return { queued };
}

/**
 * Send a sign-in code over WhatsApp (authentication template) synchronously.
 * 'not_configured' → lib/auth falls back to its dev/demo behaviour.
 *
 * Only the 'meta' provider actually delivers a code. The log provider (and an
 * unconfigured provider) return 'not_configured', which keeps the auth flow honest:
 * a code that was only console-logged is not a delivered code.
 */
export async function sendAuthCode(mobile: string, code: string): Promise<'sent' | 'not_configured'> {
  const normalized = normalizeMobile(mobile);
  if (!normalized) return 'not_configured';

  let provider;
  try {
    provider = resolveProvider();
  } catch {
    return 'not_configured';
  }
  if (provider.name !== 'meta') return 'not_configured';

  const db = await getDb();
  const user = await col.users(db).findOne({ mobile: normalized });
  const lang: Lang = user?.lang ?? 'en';

  // Render is validated here too so a param bug is caught before the wire call.
  render('auth_code', lang, { code });

  const result = await provider.send({
    mobile: normalized,
    template: 'auth_code',
    lang,
    params: { code },
  });
  return result.ok ? 'sent' : 'not_configured';
}

/**
 * Apply an inbound provider status receipt (sent/delivered/read/failed) to the
 * outbox row with this providerMessageId. Never moves a message backwards. Used by
 * the WhatsApp webhook. Returns true when a row was actually advanced.
 */
export async function applyStatusReceipt(
  providerMessageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
  at: Date,
  db?: Db,
  error?: string,
): Promise<boolean> {
  const d = db ?? (await getDb());
  const outbox = col.outbox(d);
  const row = await outbox.findOne({ providerMessageId });
  if (!row?._id) return false;
  if (!outranks(status, row.status)) return false;
  await outbox.updateOne(
    { _id: row._id },
    { $set: { status, updatedAt: at, ...(error ? { error } : {}) } },
  );
  return true;
}
