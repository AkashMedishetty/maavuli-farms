/**
 * Cancellation refunds (per the published policy) and the Razorpay refund
 * lifecycle, including the manual-UPI path for payments older than 6 months.
 * OWNER: B3 (money). Keep the signatures; replace the bodies.
 */

import type { ObjectId } from 'mongodb';
import type { Refund, RefundBreakdown } from './models';
import type { OpCtx } from './clock';

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

/** PURE. The policy formula: plan - chargedDays x standard daily, floored at 0; split source vs credit. */
export function computeCancellationRefund(input: RefundCalcInput): RefundBreakdown {
  void input;
  throw new Error('not implemented: computeCancellationRefund (owner B3)');
}

/** What cancelling `subscriptionId` right now would refund (no writes). */
export async function previewCancellationRefund(subscriptionId: ObjectId, ctx: OpCtx): Promise<RefundBreakdown> {
  void subscriptionId;
  void ctx;
  throw new Error('not implemented: previewCancellationRefund (owner B3)');
}

/**
 * Called by lib/subscriptions.cancelSubscription AFTER the subscription is
 * cancelled. Creates the Refund (or returns null when nothing is owed), returns the
 * credit portion to the ledger, and starts the Razorpay refund — or parks it in
 * awaiting_upi when the payment is older than 6 months. Idempotent per subscription.
 */
export async function createCancellationRefund(subscriptionId: ObjectId, ctx: OpCtx): Promise<Refund | null> {
  void subscriptionId;
  void ctx;
  throw new Error('not implemented: createCancellationRefund (owner B3)');
}

/** pending|failed → processing via the Razorpay refunds API (or → awaiting_upi when it cannot). */
export async function processRefund(refundId: ObjectId, ctx: OpCtx): Promise<Refund> {
  void refundId;
  void ctx;
  throw new Error('not implemented: processRefund (owner B3)');
}

/** awaiting_upi → paid_manually, with the UTR ops paid it under. */
export async function recordManualRefund(
  refundId: ObjectId,
  input: { upiId: string; utr: string },
  ctx: OpCtx,
): Promise<Refund> {
  void refundId;
  void input;
  void ctx;
  throw new Error('not implemented: recordManualRefund (owner B3)');
}

/** The customer supplies a UPI id for an awaiting_upi refund. */
export async function setRefundUpi(refundId: ObjectId, mobile: string, upiId: string, ctx: OpCtx): Promise<Refund> {
  void refundId;
  void mobile;
  void upiId;
  void ctx;
  throw new Error('not implemented: setRefundUpi (owner B3)');
}

/** Razorpay webhook: refund.processed / refund.failed. */
export async function handleRazorpayRefundEvent(
  event: 'refund.created' | 'refund.processed' | 'refund.failed',
  refund: { id: string; payment_id: string; amount: number; status?: string },
  ctx: OpCtx,
): Promise<void> {
  void event;
  void refund;
  void ctx;
  throw new Error('not implemented: handleRazorpayRefundEvent (owner B3)');
}
