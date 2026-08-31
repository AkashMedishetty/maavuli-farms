import { NextResponse } from 'next/server';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col } from '@/lib/models';
import { verifyWebhookSignature } from '@/lib/razorpay';
import { activateSubscriptionForOrder } from '@/lib/subscriptions';

/**
 * POST /api/webhooks/razorpay
 *
 * The order of operations here is the security model, not a style choice:
 *
 *   1. Read the RAW body text BEFORE any JSON parsing. The HMAC is over exact
 *      bytes; re-serialising parsed JSON would change them and break the check.
 *   2. Verify `x-razorpay-signature` FIRST. An unverified webhook lets anyone mark
 *      an order paid — a free money-printing bug.
 *   3. Idempotency via webhook_events.eventId (unique index). Razorpay retries, so
 *      a duplicate event must be a no-op 200.
 *
 * We deliberately return 200 for events we ignore, so Razorpay stops retrying them.
 * We never log secrets, signatures, or full payloads.
 */

// Minimal shapes of the payload fields we read. Razorpay sends far more.
interface RazorpayWebhook {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string } };
    order?: { entity?: { id?: string } };
  };
}

export async function POST(req: Request) {
  // (1) raw bytes, before anything touches JSON
  const rawBody = await req.text();
  const signature = req.headers.get('x-razorpay-signature');

  // (2) verify signature first
  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const eventId = req.headers.get('x-razorpay-event-id');
  if (!eventId) {
    return NextResponse.json({ error: 'Missing event id' }, { status: 400 });
  }

  let parsed: RazorpayWebhook;
  try {
    parsed = JSON.parse(rawBody) as RazorpayWebhook;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const event = parsed.event ?? 'unknown';

  try {
    const db = await getDb();

    // (3) idempotency — insert first; a duplicate key means we already have it.
    try {
      await col.webhookEvents(db).insertOne({
        eventId,
        event,
        receivedAt: new Date(),
      });
    } catch (err) {
      // Duplicate key (11000) => already processed (or in flight). Ack and stop
      // the retry storm. Any other insert error is a real failure.
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: number }).code === 11000) {
        return NextResponse.json({ status: 'duplicate' }, { status: 200 });
      }
      throw err;
    }

    switch (event) {
      case 'payment.captured':
      case 'order.paid': {
        const orderId =
          parsed.payload?.payment?.entity?.order_id ?? parsed.payload?.order?.entity?.id;
        const paymentId = parsed.payload?.payment?.entity?.id;
        if (!orderId) break; // nothing to act on; still ack below

        const updated = await col.orders(db).findOneAndUpdate(
          // only transition an unpaid order — guards against a stray order.paid
          // after a manual refund flipping state back
          { razorpayOrderId: orderId, status: { $in: ['created', 'failed'] } },
          {
            $set: {
              status: 'paid',
              paidAt: new Date(),
              ...(paymentId ? { razorpayPaymentId: paymentId } : {}),
            },
          },
          { returnDocument: 'after' },
        );

        // Only activate once, when we actually moved the order to paid.
        if (updated && updated._id) {
          await activateSubscriptionForOrder(updated._id);
        }
        break;
      }

      case 'payment.failed': {
        const orderId =
          parsed.payload?.payment?.entity?.order_id ?? parsed.payload?.order?.entity?.id;
        if (orderId) {
          await col.orders(db).updateOne(
            { razorpayOrderId: orderId, status: 'created' },
            { $set: { status: 'failed' } },
          );
        }
        break;
      }

      default:
        // Deliberately ignored event — ack so Razorpay stops retrying.
        break;
    }

    await col.webhookEvents(db).updateOne(
      { eventId },
      { $set: { processedAt: new Date() } },
    );

    return NextResponse.json({ status: 'ok' }, { status: 200 });
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      // Cannot process without a DB. Return 5xx so Razorpay retries later — the
      // event id was not durably stored, so the retry is safe.
      return NextResponse.json({ error: 'not configured' }, { status: 503 });
    }
    // A genuine processing error: 500 so Razorpay retries. We do not log the
    // payload or signature.
    return NextResponse.json({ error: 'processing error' }, { status: 500 });
  }
}
