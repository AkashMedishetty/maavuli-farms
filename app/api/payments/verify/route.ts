import { ok, readJson, handleRouteError, jsonError } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { actorFor, requireSignedIn } from '@/lib/roles';
import { getDb } from '@/lib/db';
import { col } from '@/lib/models';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { verifyPaymentSignature } from '@/lib/razorpay';
import { markOrderPaid } from '@/lib/orders';

/**
 * POST /api/payments/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 *
 * The synchronous half of payment confirmation (the webhook is the durable backstop).
 *  1. signature first (RAZORPAY_KEY_SECRET over "<order_id>|<payment_id>")
 *  2. ownership: the order must be the session's (404 otherwise)
 *  3. markOrderPaid is idempotent and guards the transition, so this and the
 *     webhook race safely.
 */
export const dynamic = 'force-dynamic';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function POST(req: Request) {
  let rzOrderId: string | null = null;
  try {
    const p = await requireSignedIn();
    const body = await readJson(req);
    rzOrderId = str(body.razorpay_order_id);
    const paymentId = str(body.razorpay_payment_id);
    const signature = str(body.razorpay_signature);
    if (!rzOrderId || !paymentId || !signature) {
      throw new ValidationError('razorpay_order_id, razorpay_payment_id and razorpay_signature are all required.');
    }
    if (!verifyPaymentSignature(rzOrderId, paymentId, signature)) {
      throw new ValidationError('Payment could not be verified.');
    }
    const db = await getDb();
    const order = await col.orders(db).findOne({ razorpayOrderId: rzOrderId });
    if (!order?._id || order.mobile !== p.mobile) throw new NotFoundError('Unknown order.');

    const alreadyPaid = order.status === 'paid';
    const ctx = ctxFor(req, actorFor(p, 'customer'));
    const paid = await markOrderPaid(order._id, { razorpayPaymentId: paymentId, source: 'verify' }, ctx);
    const sub = await col.subscriptions(db).findOne({ orderId: order._id });
    return ok({
      status: alreadyPaid ? 'already_paid' : 'paid',
      orderStatus: paid.status,
      orderId: order._id.toHexString(),
      subscriptionId: sub?._id?.toHexString() ?? null,
      startDate: sub?.startDate ?? null,
      endDate: sub?.endDate ?? null,
    });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof NotFoundError) return handleRouteError(err);
    const res = handleRouteError(err);
    if (res.status === 500) {
      // Money moved but activation failed: loud, and never "payment failed".
      // eslint-disable-next-line no-console
      console.error('[payments/verify] fulfilment failed for order', rzOrderId);
      return jsonError(500, 'Your payment went through but we could not activate the plan. We have logged it — please contact us and do not pay again.');
    }
    return res;
  }
}
