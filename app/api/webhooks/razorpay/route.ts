import { getDb, NotConfiguredError } from '@/lib/db';
import { col } from '@/lib/models';
import { verifyWebhookSignature } from '@/lib/razorpay';
import { markOrderFailed, markOrderPaid } from '@/lib/orders';
import { handleRazorpayRefundEvent } from '@/lib/refunds';
import { systemCtx } from '@/lib/clock';
import { jsonError, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/razorpay
 *
 * The order of operations is the security model:
 *   1. Read the RAW body before any JSON parsing — the HMAC is over exact bytes.
 *   2. Verify `x-razorpay-signature` FIRST. An unverified webhook lets anyone mark an
 *      order paid.
 *   3. Idempotency via webhook_events.eventId (unique). A duplicate of an event that
 *      was PROCESSED is a no-op 200. If processing fails, the claim row is removed and
 *      we answer 500, so Razorpay's retry actually re-processes it (otherwise the
 *      retry would hit the duplicate and be acked with nothing done).
 *
 * Ignored events get 200 so Razorpay stops retrying them. Secrets, signatures and
 * payloads are never logged.
 */

interface RazorpayWebhook {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string } };
    order?: { entity?: { id?: string } };
    refund?: { entity?: { id?: string; payment_id?: string; amount?: number; status?: string; receipt?: string | null; notes?: unknown } };
  };
}

const REFUND_EVENTS = new Set(['refund.created', 'refund.processed', 'refund.failed']);

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!verifyWebhookSignature(rawBody, req.headers.get('x-razorpay-signature'))) {
    return jsonError(400, 'Invalid signature');
  }
  const eventId = req.headers.get('x-razorpay-event-id');
  if (!eventId) return jsonError(400, 'Missing event id');

  let parsed: RazorpayWebhook;
  try {
    parsed = JSON.parse(rawBody) as RazorpayWebhook;
  } catch {
    return jsonError(400, 'Invalid JSON');
  }
  const event = typeof parsed.event === 'string' ? parsed.event : 'unknown';
  const ctx = systemCtx(new Date(), 'razorpay_webhook');

  let db;
  try {
    db = await getDb();
  } catch (err) {
    if (err instanceof NotConfiguredError) return jsonError(503, 'not configured');
    return jsonError(500, 'processing error');
  }

  try {
    await col.webhookEvents(db).insertOne({ eventId, event, receivedAt: new Date() });
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      return ok({ status: 'duplicate' });
    }
    return jsonError(500, 'processing error');
  }

  try {
    switch (event) {
      case 'payment.captured':
      case 'order.paid': {
        const rzOrderId = parsed.payload?.payment?.entity?.order_id ?? parsed.payload?.order?.entity?.id;
        const paymentId = parsed.payload?.payment?.entity?.id;
        if (!rzOrderId) break;
        const order = await col.orders(db).findOne({ razorpayOrderId: rzOrderId }, { projection: { _id: 1 } });
        if (!order?._id) break; // not ours — ack
        await markOrderPaid(order._id, { ...(paymentId ? { razorpayPaymentId: paymentId } : {}), source: 'webhook' }, ctx);
        break;
      }
      case 'payment.failed': {
        const rzOrderId = parsed.payload?.payment?.entity?.order_id ?? parsed.payload?.order?.entity?.id;
        if (!rzOrderId) break;
        const order = await col.orders(db).findOne({ razorpayOrderId: rzOrderId }, { projection: { _id: 1 } });
        if (order?._id) await markOrderFailed(order._id, ctx);
        break;
      }
      default: {
        if (REFUND_EVENTS.has(event)) {
          const r = parsed.payload?.refund?.entity;
          if (r?.id && r.payment_id && typeof r.amount === 'number') {
            await handleRazorpayRefundEvent(
              event as 'refund.created' | 'refund.processed' | 'refund.failed',
              {
                id: r.id,
                payment_id: r.payment_id,
                amount: r.amount,
                ...(r.status ? { status: r.status } : {}),
                ...(typeof r.receipt === 'string' ? { receipt: r.receipt } : {}),
                ...(r.notes ? { notes: r.notes } : {}),
              },
              ctx,
            );
          }
        }
        break;
      }
    }
    await col.webhookEvents(db).updateOne({ eventId }, { $set: { processedAt: new Date() } });
    return ok({ status: 'ok' });
  } catch (err) {
    // release the claim so the retry re-processes; never log the payload
    await col.webhookEvents(db).deleteOne({ eventId, processedAt: { $exists: false } }).catch(() => undefined);
    // eslint-disable-next-line no-console
    console.error('[webhook/razorpay] processing failed', event, err instanceof Error ? err.name : 'error');
    return jsonError(500, 'processing error');
  }
}
