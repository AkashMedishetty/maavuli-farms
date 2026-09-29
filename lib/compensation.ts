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
