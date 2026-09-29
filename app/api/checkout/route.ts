import { ok, readJson, handleRouteError } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { actorFor, requireSignedIn } from '@/lib/roles';
import { ValidationError } from '@/lib/errors';
import { createCheckoutOrder } from '@/lib/orders';
import { parseDetails, parsePlan } from './_parse';

/**
 * POST /api/checkout — create a prepaid order for the SIGNED-IN customer (401 otherwise).
 *
 * Body: { purpose?, kind, quantityId, tenureId, startDate?, renewsSubscriptionId?,
 *         details: { name, address, location:{lat,lng}, landmark?, instructions?, addressParts? },
 *         useCredit?, whatsappOptIn?, idempotencyKey }
 *
 * The amount is recomputed server-side (lib/pricing); a client amount is never read.
 * Response: { orderId, status, razorpay: {orderId,keyId,amountPaise} | null, preview }.
 * razorpay null = paid entirely from credit and already activated.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const p = await requireSignedIn();
    const body = await readJson(req);
    const plan = parsePlan(body);
    const details = parseDetails(body.details);
    if (body.whatsappOptIn !== undefined && typeof body.whatsappOptIn !== 'boolean') {
      throw new ValidationError('whatsappOptIn must be true or false');
    }
    if (typeof body.idempotencyKey !== 'string') throw new ValidationError('idempotencyKey is required');
    const res = await createCheckoutOrder(
      {
        ...plan,
        mobile: p.mobile,
        details,
        ...(typeof body.whatsappOptIn === 'boolean' ? { whatsappOptIn: body.whatsappOptIn } : {}),
        idempotencyKey: body.idempotencyKey,
      },
      ctxFor(req, actorFor(p, 'customer')),
    );
    return ok({
      orderId: res.order._id.toHexString(),
      status: res.order.status,
      razorpay: res.razorpay,
      preview: res.preview,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
