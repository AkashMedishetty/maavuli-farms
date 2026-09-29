import { ok, readJson, handleRouteError } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { actorFor, requireSignedIn } from '@/lib/roles';
import { pauseDates } from '@/lib/pause';
import { ownSubscription } from '../../_lib';

/** POST /api/subscriptions/[id]/pause  { dates: ["YYYY-MM-DD", ...] } — own plan only (404 otherwise). */
export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const p = await requireSignedIn();
    const sub = await ownSubscription(context.params, p);
    const body = await readJson<{ dates?: unknown }>(req);
    const result = await pauseDates(sub._id, body.dates as string[], ctxFor(req, actorFor(p, 'customer')));
    return ok({ ...result });
  } catch (err) {
    return handleRouteError(err);
  }
}
