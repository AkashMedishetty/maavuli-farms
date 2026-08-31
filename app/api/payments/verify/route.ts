import { NextResponse } from 'next/server';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col } from '@/lib/models';
import { verifyPaymentSignature } from '@/lib/razorpay';
import { activateSubscriptionForOrder } from '@/lib/subscriptions';
import { getSession } from '@/lib/auth';

/**
 * POST /api/payments/verify
 *
 * The synchronous half of payment confirmation, and the reason a paid order was
 * never becoming a subscription: fulfilment existed ONLY in the Razorpay webhook,
 * and Razorpay cannot reach a loopback address. Locally the order sat at "created"
 * for ever; in production the customer would see Razorpay say "success" while the
 * site still showed nothing until the webhook happened to land.
 *
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 *       — exactly the three fields Razorpay Checkout gives its success handler.
 *
 * The security model, in order:
 *   1. Signature first. Without it, any caller could POST an order id and mint a
 *      free subscription. Verified with RAZORPAY_KEY_SECRET over
 *      "<order_id>|<payment_id>" — NOT the webhook secret, and not over the body.
 *   2. Ownership. A valid signature proves the payment is real, not that it is
 *      YOURS, so the order's mobile must match the session's. Otherwise one
 *      customer could claim another's order by replaying public ids.
 *   3. Idempotency. The state transition is guarded to created|failed -> paid, so
 *      this route and the webhook race safely: whoever wins does the activation,
 *      the loser is a no-op and still answers 200.
 */

export const dynamic = 'force-dynamic';

interface Body {
  razorpay_order_id?: unknown;
  razorpay_payment_id?: unknown;
  razorpay_signature?: unknown;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

export async function POST(req: Request): Promise<NextResponse> {
  // Require a session before anything else: this route mutates paid state, and an
  // anonymous caller has no order to confirm.
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Sign in to confirm a payment.' }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const orderId = str(body.razorpay_order_id);
  const paymentId = str(body.razorpay_payment_id);
  const signature = str(body.razorpay_signature);

  if (!orderId || !paymentId || !signature) {
    return NextResponse.json(
      {
        error:
          'razorpay_order_id, razorpay_payment_id and razorpay_signature are all required.',
      },
      { status: 400 },
    );
  }

  // (1) signature before any database work
  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    // Deliberately vague to the caller; we do not say which part failed.
    return NextResponse.json({ error: 'Payment could not be verified.' }, { status: 400 });
  }

  try {
    const db = await getDb();

    const existing = await col.orders(db).findOne({ razorpayOrderId: orderId });
    if (!existing) {
      return NextResponse.json({ error: 'Unknown order.' }, { status: 404 });
    }

    // (2) ownership — a real signature is not proof the order is the caller's
    if (existing.mobile !== session.mobile) {
      return NextResponse.json({ error: 'That order is not yours.' }, { status: 403 });
    }

    // (3) already settled by the webhook (or a double submit): report success
    // without activating a second time.
    if (existing.status === 'paid') {
      const sub = await col.subscriptions(db).findOne({ orderId: existing._id });
      return NextResponse.json({
        status: 'already_paid',
        orderId: existing._id?.toHexString(),
        subscriptionId: sub?._id?.toHexString() ?? null,
      });
    }

    const updated = await col.orders(db).findOneAndUpdate(
      { razorpayOrderId: orderId, status: { $in: ['created', 'failed'] } },
      {
        $set: {
          status: 'paid',
          paidAt: new Date(),
          razorpayPaymentId: paymentId,
        },
      },
      { returnDocument: 'after' },
    );

    if (!updated?._id) {
      // The webhook won the race between our findOne and this update.
      const sub = await col.subscriptions(db).findOne({ orderId: existing._id });
      return NextResponse.json({
        status: 'already_paid',
        orderId: existing._id?.toHexString(),
        subscriptionId: sub?._id?.toHexString() ?? null,
      });
    }

    await activateSubscriptionForOrder(updated._id);

    const sub = await col.subscriptions(db).findOne({ orderId: updated._id });
    return NextResponse.json({
      status: 'paid',
      orderId: updated._id.toHexString(),
      subscriptionId: sub?._id?.toHexString() ?? null,
      startDate: sub?.startDate ?? null,
      endDate: sub?.endDate ?? null,
    });
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return NextResponse.json(
        { error: 'Payments are not configured.', missing: err.missing },
        { status: 503 },
      );
    }
    // The money moved but we failed to record it — that must be loud, and it must
    // not tell the customer "payment failed", which would be a false statement.
    console.error('[payments/verify] fulfilment failed for order', orderId, err);
    return NextResponse.json(
      {
        error:
          'Your payment went through but we could not activate the plan. We have logged it — please contact us and do not pay again.',
      },
      { status: 500 },
    );
  }
}
