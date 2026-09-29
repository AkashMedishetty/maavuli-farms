import { ok, readJson, handleRouteError } from '@/lib/api';
import { ctxFor, SYSTEM_ACTOR } from '@/lib/clock';
import { actorFor, getPrincipal } from '@/lib/roles';
import { previewCheckout } from '@/lib/orders';
import { parsePlan } from '../_parse';

/**
 * POST /api/checkout/preview — price, dates and credit for a plan, no writes.
 * Session optional: signed out, credit is 0 (and a renewal is refused).
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const p = await getPrincipal();
    const plan = parsePlan(await readJson(req));
    const ctx = ctxFor(req, p ? actorFor(p, 'customer') : SYSTEM_ACTOR);
    const preview = await previewCheckout({ ...plan, mobile: p?.mobile ?? '' }, ctx);
    return ok({ preview });
  } catch (err) {
    return handleRouteError(err);
  }
}
