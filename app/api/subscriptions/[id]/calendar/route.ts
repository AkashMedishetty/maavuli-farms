import { ok, handleRouteError } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { actorFor, requireSignedIn } from '@/lib/roles';
import { NotFoundError } from '@/lib/errors';
import { getSubscriptionCalendar } from '@/lib/pause';
import { ownSubscription } from '../../_lib';

/** GET /api/subscriptions/[id]/calendar — pause balance, paused dates, deliveries, first open date. */
export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const p = await requireSignedIn();
    const sub = await ownSubscription(context.params, p);
    const calendar = await getSubscriptionCalendar(sub._id, ctxFor(req, actorFor(p, 'customer')));
    if (!calendar) throw new NotFoundError('Subscription not found');
    return ok({ ...calendar });
  } catch (err) {
    return handleRouteError(err);
  }
}
