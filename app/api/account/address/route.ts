import { ok, readJson, handleRouteError } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { actorFor, requireSignedIn } from '@/lib/roles';
import { changeAddress, parseAddressInput } from '@/lib/account';

export const dynamic = 'force-dynamic';

/**
 * POST /api/account/address
 *   { location: {lat,lng}, addressParts: {house, floor?, building?, society?, area?, pincode?},
 *     landmark?, instructions? }
 * → { effectiveFrom, zoneName, plansUpdated, deliveriesUpdated, address }
 *
 * The signed-in customer's own doorstep. The pin must fall inside an active zone
 * (400 otherwise). Applies from the first open date; closed days keep their frozen stop.
 */
export async function POST(req: Request) {
  try {
    const p = await requireSignedIn();
    const input = parseAddressInput(await readJson(req));
    const result = await changeAddress(p.mobile, input, ctxFor(req, actorFor(p, 'customer')));
    return ok({ ...result });
  } catch (err) {
    return handleRouteError(err);
  }
}
