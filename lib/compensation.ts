/**
 * Making good a delivery WE missed. OWNER: B3 (money).
 * Keep the signatures; replace the bodies.
 *
 * Rule: a not_delivered delivery with fault 'ours' is compensated exactly once —
 *  · customer preference 'makeup_day' (default) and the subscription can still be
 *    extended → one make-up day appended (lib/subscriptions.extendSubscription,
 *    source 'makeup'); resolution 'makeup_day'
 *  · otherwise → a refundable credit worth that day's milk at the price PAID
 *    (order.perLitrePaise x litres); resolution 'credit'
 * Extras (source 'extra') are always compensated as credit of their price.
 */

import type { ObjectId } from 'mongodb';
import type { OpCtx } from './clock';

export async function compensateMissedDelivery(
  deliveryId: ObjectId,
  ctx: OpCtx,
): Promise<{ resolution: 'makeup_day' | 'credit' | 'none'; alreadyResolved: boolean }> {
  void deliveryId;
  void ctx;
  throw new Error('not implemented: compensateMissedDelivery (owner B3)');
}

/**
 * Undo a compensation when the miss turns out not to be one: the delivery was
 * re-marked delivered, or staff changed its fault from 'ours' to 'customer'.
 * A still-planned make-up day is removed (endDate moves back, via the same path
 * pause/unpause use); an unspent missed-day credit gets an offsetting entry. If the
 * make-up day already locked/was delivered, or the credit was spent, nothing is
 * clawed back — the event log records that. Clears delivery.resolution. Idempotent.
 */
export async function reverseCompensation(deliveryId: ObjectId, ctx: OpCtx): Promise<{ reversed: boolean }> {
  void deliveryId;
  void ctx;
  throw new Error('not implemented: reverseCompensation (owner B3)');
}

/**
 * Tick step: compensate every not_delivered / fault 'ours' delivery that has no
 * `resolution` yet — the retry path when compensation failed after the outcome was
 * written (lib/outcomes never lets a compensation failure undo a rider's tap).
 */
export async function compensatePendingMisses(ctx: OpCtx): Promise<{ compensated: number; failed: number }> {
  void ctx;
  throw new Error('not implemented: compensatePendingMisses (owner B3)');
}
