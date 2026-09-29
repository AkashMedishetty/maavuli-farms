/**
 * Cancellation refunds (per the published policy) and the Razorpay refund
 * lifecycle, including the manual-UPI path for payments older than 6 months.
 * OWNER: B3 (money).
 *
 * Money flow at cancellation:
 *   total = balance (plan − chargedDays × standard daily, ≥ 0) + unspent refundable
 *           missed-day credit of this subscription
 *   toSource = min(total, plan − creditApplied)   → back to the card/UPI (Razorpay)
 *   toCredit = total − toSource                    → stays / goes back to credit
 * The source share is drawn from the balance first, then from the refundable credit
 * (that credit is consumed with a 'refund_payout' ledger row, so it cannot be spent
 * AND refunded). Balance not sent to source becomes a 'cancellation_balance' credit.
 * Refundable credit not sent to source simply stays in the ledger.
 */

import type { Db, ObjectId } from 'mongodb';
import { getDb } from './db';
import { col, type Order, type Refund, type RefundBreakdown, type RefundStatus } from './models';
import type { OpCtx } from './clock';
import { PRODUCTS, formatINR } from './pricing';
import { recordEvent } from './events';
import { ORDER_TRANSITIONS, REFUND_TRANSITIONS, assertTransition } from './transitions';
import { ConflictError, NotFoundError, ServiceNotConfiguredError, ValidationError } from './errors';
import { addCredit, foldBalance, spendLocked, withCreditLock } from './credits';
import { razorpayConfig } from './env';
import { createRefund, RazorpayRefundError } from './razorpay';
import { enqueueMessage } from './notify';

export interface RefundCalcInput {
  planPaise: number;
  /** order.creditAppliedPaise — that part goes back to credit, never to the card */
  creditAppliedPaise: number;
  /** delivered + locked days */
  chargedDays: number;
  /** lib/pricing base rate x litres/day for this plan's milk and quantity */
  standardDailyPaise: number;
  /** unspent refundable credit tied to this subscription's missed days */
  refundableCreditPaise: number;
}

const nonNegInt = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/** PURE. The policy formula: plan - chargedDays x standard daily, floored at 0; split source vs credit. */
export function computeCancellationRefund(input: RefundCalcInput): RefundBreakdown {
  const planPaise = nonNegInt(input.planPaise);
  const creditApplied = Math.min(nonNegInt(input.creditAppliedPaise), planPaise);
  const chargedDays = nonNegInt(input.chargedDays);
  const standardDailyPaise = nonNegInt(input.standardDailyPaise);
  const refundableCreditPaise = nonNegInt(input.refundableCreditPaise);

  const chargedPaise = chargedDays * standardDailyPaise;
  const balancePaise = Math.max(0, planPaise - chargedPaise);
  const total = balancePaise + refundableCreditPaise;
  const toSourcePaise = Math.min(total, planPaise - creditApplied);
  const toCreditPaise = total - toSourcePaise;
  return {
    planPaise,
    chargedDays,
    standardDailyPaise,
    chargedPaise,
    balancePaise,
    refundableCreditPaise,
    toSourcePaise,
    toCreditPaise,
  };
}

/** PURE. How the source share splits between the plan balance and refundable credit. */
export function sourceSplit(b: RefundBreakdown): { fromBalance: number; fromCredit: number; balanceToCredit: number } {
  const fromBalance = Math.min(b.balancePaise, b.toSourcePaise);
  const fromCredit = b.toSourcePaise - fromBalance;
  return { fromBalance, fromCredit, balanceToCredit: b.balancePaise - fromBalance };
}

/** 6 months, as Razorpay counts it for refunds — 180 days is the conservative reading. */
export const RAZORPAY_REFUND_WINDOW_DAYS = 180;

const CHARGED_STATUSES = ['delivered', 'locked', 'out_for_delivery', 'unconfirmed'] as const;

/** standard daily = base (1-month, 0 %) rate × litres/day, integer paise. */
export function standardDailyPaise(kind: string, qtyNum: number, qtyDen: number): number {
  const product = PRODUCTS.find(p => p.kind === kind);
  if (!product) throw new Error(`unknown milk kind "${kind}"`);
  return Math.round((product.baseRatePaise * qtyNum) / qtyDen);
}

async function refundableCreditFor(db: Db, mobile: string, subscriptionId: ObjectId): Promise<number> {
  const all = await col
    .credits(db)
    .find({ mobile }, { projection: { amountPaise: 1, kind: 1, refundable: 1, deliveryId: 1, subscriptionId: 1 } })
    .toArray();
  const overall = foldBalance(all).refundablePaise;
  // Refundable value tagged to THIS subscription (missed days in, payouts/clawbacks
  // out), capped by what the customer really still holds as refundable overall —
  // untagged spends (an extra paid from credit) reduce the latter, not the former.
  const tagged = all
    .filter(r => r.subscriptionId?.equals(subscriptionId))
    .reduce((s, r) => {
      if (r.amountPaise > 0 && r.refundable) return s + r.amountPaise;
      if (r.amountPaise < 0 && (r.kind === 'refund_payout' || (r.kind === 'adjustment' && r.deliveryId))) return s + r.amountPaise;
      return s;
    }, 0);
  return Math.max(0, Math.min(tagged, overall));
}

async function breakdownFor(db: Db, subscriptionId: ObjectId): Promise<{ breakdown: RefundBreakdown; order: Order & { _id: ObjectId }; mobile: string }> {
  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });
  if (!sub) throw new NotFoundError('Subscription not found');
  const order = await col.orders(db).findOne({ _id: sub.orderId });
  if (!order?._id) throw new NotFoundError('Order for this subscription not found');
  // Charged: every day that went (or is going) out, plus days the CUSTOMER missed
  // (not home, refused, asked to skip) — the milk was prepared and the rider went.
  // Days WE missed are not charged: they are compensated separately (a make-up day
  // that is itself counted when delivered, or refundable credit).
  const chargedDays = await col.deliveries(db).countDocuments({
    subscriptionId,
    $and: [
      { $or: [{ status: { $in: [...CHARGED_STATUSES] } }, { status: 'not_delivered', fault: 'customer' }] },
      { $or: [{ source: { $in: ['plan', 'makeup'] } }, { source: { $exists: false } }] },
    ],
  });
  const breakdown = computeCancellationRefund({
    planPaise: order.amountPaise,
    creditAppliedPaise: order.creditAppliedPaise ?? 0,
    chargedDays,
    standardDailyPaise: standardDailyPaise(sub.kind, sub.qtyNum, sub.qtyDen),
    refundableCreditPaise: await refundableCreditFor(db, sub.mobile, subscriptionId),
  });
  return { breakdown, order: order as Order & { _id: ObjectId }, mobile: sub.mobile };
}

/** What cancelling `subscriptionId` right now would refund (no writes). */
export async function previewCancellationRefund(subscriptionId: ObjectId, ctx: OpCtx): Promise<RefundBreakdown> {
  void ctx; // the charged-day count is read from delivery statuses, not from time
  return (await breakdownFor(await getDb(), subscriptionId)).breakdown;
}

/**
 * Apply the credit side of a breakdown exactly once (keyed by subscription for the
 * balance credit and by refund for the payout). Safe to re-run after a crash.
 */
async function applyCreditSide(
  db: Db,
  mobile: string,
  subscriptionId: ObjectId,
  orderId: ObjectId,
  refundId: ObjectId | null,
  b: RefundBreakdown,
  ctx: OpCtx,
): Promise<void> {
  const { fromCredit, balanceToCredit } = sourceSplit(b);
  if (balanceToCredit > 0) {
    const have = await col.credits(db).countDocuments({ subscriptionId, kind: 'cancellation_balance' }, { limit: 1 });
    if (!have) {
      await addCredit(
        {
          mobile,
          amountPaise: balanceToCredit,
          kind: 'cancellation_balance',
          // it replaces credit that paid for the plan, so it behaves like that credit
          refundable: false,
          subscriptionId,
          orderId,
          ...(refundId ? { refundId } : {}),
          note: 'Cancellation balance returned to credit',
        },
        ctx,
      );
    }
  }
  if (fromCredit > 0 && refundId) {
    await withCreditLock(mobile, async d => {
      const paid = await col.credits(d).countDocuments({ refundId, kind: 'refund_payout' }, { limit: 1 });
      if (paid) return;
      await spendLocked(d, mobile, fromCredit, 'refund_payout', { refundId, subscriptionId, orderId, note: 'Missed-day credit refunded' }, ctx);
    });
  }
}

/**
 * Called by lib/subscriptions.cancelSubscription AFTER the subscription is
 * cancelled. Creates the Refund (or returns null when nothing is owed to the source),
 * returns the credit portion to the ledger, and starts the Razorpay refund — or
 * parks it in awaiting_upi when the payment is older than 6 months. Idempotent per
 * subscription (unique index refunds.subscriptionId).
 */
export async function createCancellationRefund(subscriptionId: ObjectId, ctx: OpCtx): Promise<Refund | null> {
  const db = await getDb();
  const existing = await col.refunds(db).findOne({ subscriptionId });
  if (existing?._id) {
    await applyCreditSide(db, existing.mobile, subscriptionId, existing.orderId, existing._id, existing.breakdown, ctx);
    return existing;
  }
  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId }, { projection: { status: 1 } });
  if (!sub) throw new NotFoundError('Subscription not found');
  if (sub.status !== 'cancelled') throw new ConflictError('Only a cancelled subscription is refunded.');

  const { breakdown, order, mobile } = await breakdownFor(db, subscriptionId);

  if (breakdown.toSourcePaise <= 0) {
    // Nothing goes back to the payment; any balance still returns to credit.
    await applyCreditSide(db, mobile, subscriptionId, order._id, null, breakdown, ctx);
    return null;
  }

  const doc: Refund = {
    mobile,
    subscriptionId,
    orderId: order._id,
    amountPaise: breakdown.toSourcePaise,
    breakdown,
    method: 'razorpay',
    status: 'pending',
    ...(order.razorpayPaymentId ? { razorpayPaymentId: order.razorpayPaymentId } : {}),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  let refundId: ObjectId;
  try {
    refundId = (await col.refunds(db).insertOne(doc)).insertedId;
  } catch (err) {
    if (isDup(err)) {
      const won = await col.refunds(db).findOne({ subscriptionId });
      if (won) return won;
    }
    throw err;
  }
  await recordEvent(
    ctx,
    {
      entity: 'refund',
      entityId: refundId.toHexString(),
      type: 'refund.created',
      to: 'pending',
      mobile,
      data: { amountPaise: doc.amountPaise, subscriptionId: subscriptionId.toHexString(), breakdown: { ...breakdown } },
    },
    db,
  );
  await applyCreditSide(db, mobile, subscriptionId, order._id, refundId, breakdown, ctx);

  // Start the payout. A missing Razorpay config or a transient failure must not undo
  // the cancellation: the refund stays pending/failed and ops can retry it.
  try {
    return await processRefund(refundId, ctx);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[refunds] payout not started', refundId.toHexString(), err instanceof Error ? err.message : err);
    return (await col.refunds(db).findOne({ _id: refundId })) ?? { ...doc, _id: refundId };
  }
}

function isDup(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code?: number }).code === 11000;
}

/** Status write per contract §2: transition check, conditional on FROM, event. */
async function moveRefund(
  db: Db,
  r: Refund & { _id: ObjectId },
  to: RefundStatus,
  set: Partial<Refund>,
  ctx: OpCtx,
  reason?: string,
): Promise<Refund & { _id: ObjectId }> {
  assertTransition('refund', REFUND_TRANSITIONS, r.status, to);
  const res = await col.refunds(db).findOneAndUpdate(
    { _id: r._id, status: r.status },
    { $set: { ...set, status: to, updatedAt: ctx.now } },
    { returnDocument: 'after' },
  );
  if (!res?._id) throw new ConflictError('This refund was changed by someone else — reload and try again.');
  await recordEvent(
    ctx,
    {
      entity: 'refund',
      entityId: r._id.toHexString(),
      type: `refund.${to}`,
      from: r.status,
      to,
      mobile: r.mobile,
      ...(reason ? { reason } : {}),
      data: { amountPaise: r.amountPaise },
    },
    db,
  );
  return res as Refund & { _id: ObjectId };
}

async function parkForUpi(db: Db, r: Refund & { _id: ObjectId }, reason: string, ctx: OpCtx): Promise<Refund & { _id: ObjectId }> {
  const parked = await moveRefund(db, r, 'awaiting_upi', { method: 'manual_upi', failureReason: reason }, ctx, reason);
  await enqueueMessage(
    {
      mobile: r.mobile,
      template: 'refund_needs_upi',
      params: { amount: formatINR(r.amountPaise), link: '/account' },
      dedupeKey: `refund_upi:${r._id.toHexString()}`,
    },
    ctx,
  );
  return parked;
}

/** pending|failed → processing via the Razorpay refunds API (or → awaiting_upi when it cannot). */
export async function processRefund(refundId: ObjectId, ctx: OpCtx): Promise<Refund> {
  const db = await getDb();
  const r = (await col.refunds(db).findOne({ _id: refundId })) as (Refund & { _id: ObjectId }) | null;
  if (!r) throw new NotFoundError('Refund not found');
  if (r.status !== 'pending' && r.status !== 'failed') {
    throw new ConflictError(`This refund is ${r.status.replace('_', ' ')} — it cannot be processed again.`, { status: r.status });
  }
  const order = await col.orders(db).findOne({ _id: r.orderId });
  const paymentId = r.razorpayPaymentId ?? order?.razorpayPaymentId;
  const paidAt = order?.paidAt;
  const ageDays = paidAt ? (ctx.now.getTime() - paidAt.getTime()) / 86_400_000 : Infinity;

  if (!paymentId) return parkForUpi(db, r, 'no Razorpay payment to refund to', ctx);
  if (ageDays > RAZORPAY_REFUND_WINDOW_DAYS) return parkForUpi(db, r, 'payment older than 6 months', ctx);

  const cfg = razorpayConfig();
  if (!cfg.ok) throw new ServiceNotConfiguredError('Razorpay', cfg.missing);

  // Claim before calling out, so two clicks cannot create two Razorpay refunds.
  const processing = await moveRefund(db, r, 'processing', { razorpayPaymentId: paymentId }, ctx);
  try {
    const rz = await createRefund({
      paymentId,
      amountPaise: r.amountPaise,
      receipt: `refund_${refundId.toHexString()}`,
      notes: { refundId: refundId.toHexString(), subscriptionId: r.subscriptionId.toHexString() },
    });
    const saved = await col.refunds(db).findOneAndUpdate(
      { _id: refundId, status: 'processing' },
      { $set: { razorpayRefundId: rz.id, updatedAt: ctx.now } },
      { returnDocument: 'after' },
    );
    // Razorpay can report a refund processed synchronously; the webhook will say so too.
    if (rz.status === 'processed') {
      await settleProcessed(db, (saved ?? { ...processing, razorpayRefundId: rz.id }) as Refund & { _id: ObjectId }, ctx);
      return (await col.refunds(db).findOne({ _id: refundId })) ?? processing;
    }
    return saved ?? processing;
  } catch (err) {
    if (err instanceof RazorpayRefundError) {
      const failed = await moveRefund(db, processing, 'failed', { failureReason: err.message }, ctx, err.message);
      if (err.notSupported) return parkForUpi(db, failed, 'Razorpay cannot refund this payment', ctx);
      return failed;
    }
    // Network error: we cannot know whether Razorpay created the refund. Mark failed
    // with the reason so ops check the dashboard before retrying.
    const msg = 'Could not reach Razorpay — check the Razorpay dashboard before retrying';
    return moveRefund(db, processing, 'failed', { failureReason: msg }, ctx, msg);
  }
}

/** Add `amountPaise` to order.refundedPaise and move the order status accordingly. */
async function applyToOrder(db: Db, orderId: ObjectId, amountPaise: number, ctx: OpCtx): Promise<void> {
  const order = await col.orders(db).findOneAndUpdate(
    { _id: orderId },
    { $inc: { refundedPaise: amountPaise } },
    { returnDocument: 'after' },
  );
  if (!order) return;
  const paidOut = order.payablePaise ?? order.amountPaise - (order.creditAppliedPaise ?? 0);
  const to = (order.refundedPaise ?? 0) >= paidOut ? 'refunded' : 'partially_refunded';
  if (order.status === to) return;
  if (order.status !== 'paid' && order.status !== 'partially_refunded') return;
  assertTransition('order', ORDER_TRANSITIONS, order.status, to);
  const res = await col.orders(db).updateOne({ _id: orderId, status: order.status }, { $set: { status: to } });
  if (res.matchedCount === 1) {
    await recordEvent(
      ctx,
      { entity: 'order', entityId: orderId.toHexString(), type: `order.${to}`, from: order.status, to, mobile: order.mobile, data: { refundedPaise: order.refundedPaise } },
      db,
    );
  }
}

async function settleProcessed(db: Db, r: Refund & { _id: ObjectId }, ctx: OpCtx): Promise<void> {
  if (r.status !== 'processing') return;
  await moveRefund(db, r, 'processed', {}, ctx);
  await applyToOrder(db, r.orderId, r.amountPaise, ctx);
  await enqueueMessage(
    {
      mobile: r.mobile,
      template: 'refund_processed',
      params: { amount: formatINR(r.amountPaise) },
      dedupeKey: `refund_done:${r._id.toHexString()}`,
    },
    ctx,
  );
}

const UTR_RE = /^[A-Za-z0-9]{6,30}$/;

/** A UPI VPA: handle@provider. Not exhaustive by design — the bank validates for real. */
export function isValidUpiId(v: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,254}@[A-Za-z][A-Za-z0-9.-]{1,63}$/.test(v);
}

/** awaiting_upi → paid_manually, with the UTR ops paid it under. */
export async function recordManualRefund(
  refundId: ObjectId,
  input: { upiId: string; utr: string },
  ctx: OpCtx,
): Promise<Refund> {
  const upiId = input.upiId.trim();
  const utr = input.utr.trim();
  const issues: string[] = [];
  if (!isValidUpiId(upiId)) issues.push('upiId must look like name@bank');
  if (!UTR_RE.test(utr)) issues.push('utr must be 6–30 letters or digits');
  if (issues.length) throw new ValidationError('Invalid manual refund', issues);
  const db = await getDb();
  const r = (await col.refunds(db).findOne({ _id: refundId })) as (Refund & { _id: ObjectId }) | null;
  if (!r) throw new NotFoundError('Refund not found');
  if (r.status === 'paid_manually' && r.utr === utr) return r; // idempotent replay
  const done = await moveRefund(db, r, 'paid_manually', { upiId, utr, method: 'manual_upi' }, ctx);
  await applyToOrder(db, r.orderId, r.amountPaise, ctx);
  await enqueueMessage(
    {
      mobile: r.mobile,
      template: 'refund_processed',
      params: { amount: formatINR(r.amountPaise) },
      dedupeKey: `refund_done:${r._id.toHexString()}`,
    },
    ctx,
  );
  return done;
}

/** The customer supplies a UPI id for an awaiting_upi refund. */
export async function setRefundUpi(refundId: ObjectId, mobile: string, upiId: string, ctx: OpCtx): Promise<Refund> {
  const v = upiId.trim();
  if (!isValidUpiId(v)) throw new ValidationError('Enter a UPI id like name@bank', ['upiId must look like name@bank']);
  const db = await getDb();
  const r = await col.refunds(db).findOne({ _id: refundId });
  // another customer's refund is "not found", never "forbidden"
  if (!r?._id || r.mobile !== mobile) throw new NotFoundError('Refund not found');
  if (r.status !== 'awaiting_upi') throw new ConflictError('This refund does not need a UPI id.', { status: r.status });
  const res = await col.refunds(db).findOneAndUpdate(
    { _id: refundId, status: 'awaiting_upi' },
    { $set: { upiId: v, updatedAt: ctx.now } },
    { returnDocument: 'after' },
  );
  if (!res) throw new ConflictError('This refund changed — reload and try again.');
  await recordEvent(ctx, { entity: 'refund', entityId: refundId.toHexString(), type: 'refund.upi_set', mobile }, db);
  return res;
}

/** Razorpay webhook: refund.processed / refund.failed. */
export async function handleRazorpayRefundEvent(
  event: 'refund.created' | 'refund.processed' | 'refund.failed',
  refund: { id: string; payment_id: string; amount: number; status?: string },
  ctx: OpCtx,
): Promise<void> {
  const db = await getDb();
  let r = (await col.refunds(db).findOne({ razorpayRefundId: refund.id })) as (Refund & { _id: ObjectId }) | null;
  if (!r) {
    // The webhook can beat our own write of razorpayRefundId.
    r = (await col.refunds(db).findOne({
      razorpayPaymentId: refund.payment_id,
      status: 'processing',
      amountPaise: refund.amount,
    })) as (Refund & { _id: ObjectId }) | null;
    if (r) {
      await col.refunds(db).updateOne({ _id: r._id, razorpayRefundId: { $exists: false } }, { $set: { razorpayRefundId: refund.id } });
    }
  }
  if (!r) return; // not a refund we started (e.g. issued from the Razorpay dashboard) — ack
  if (event === 'refund.processed') {
    await settleProcessed(db, r, ctx);
  } else if (event === 'refund.failed' && r.status === 'processing') {
    await moveRefund(db, r, 'failed', { failureReason: 'Razorpay reported the refund failed' }, ctx, 'razorpay refund.failed');
  }
}
