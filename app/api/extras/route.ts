import { createExtraOrder } from '@/lib/extras';
import { actorFor, requireSignedIn } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { parseExtraBody } from './_input';

export const dynamic = 'force-dynamic';

/**
 * POST /api/extras {subscriptionId, date, kind, litres, useCredit, idempotencyKey}
 * Creates the extra-milk order. `razorpay` is null when credit covered it (already
 * paid and scheduled); otherwise the client opens Razorpay Checkout with it.
 */
export async function POST(req: Request) {
  try {
    const p = await requireSignedIn();
    const input = parseExtraBody(await readJson(req), p.mobile, true);
    const { order, razorpay } = await createExtraOrder(input, ctxFor(req, actorFor(p, 'customer')));
    return ok(
      {
        order: {
          id: order._id.toHexString(),
          status: order.status,
          amountPaise: order.amountPaise,
          creditAppliedPaise: order.creditAppliedPaise ?? 0,
          payablePaise: order.payablePaise ?? order.amountPaise,
          date: order.extra?.date ?? null,
          kind: order.kind,
          litres: order.litres,
        },
        razorpay,
      },
      201,
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
