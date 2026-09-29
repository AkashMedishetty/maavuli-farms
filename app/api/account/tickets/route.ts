import { ok, readJson, handleRouteError } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { actorFor, requireSignedIn } from '@/lib/roles';
import { parseTicketInput, reportDeliveryProblem } from '@/lib/account';

export const dynamic = 'force-dynamic';

/**
 * POST /api/account/tickets
 *   { deliveryId, kind: 'not_received'|'spoiled'|'quantity'|'other', note (3–500 chars) }
 * → 201 { ticket }
 *
 * Only on the customer's own delivery (404 otherwise), on or after its date, and one
 * open report per delivery (409).
 */
export async function POST(req: Request) {
  try {
    const p = await requireSignedIn();
    const input = parseTicketInput(await readJson(req));
    const ticket = await reportDeliveryProblem(p.mobile, input, ctxFor(req, actorFor(p, 'customer')));
    return ok({ ticket: { ...ticket } }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
