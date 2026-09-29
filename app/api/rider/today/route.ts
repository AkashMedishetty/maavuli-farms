import { ctxFor } from '@/lib/clock';
import { actorFor, requireRider } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';
import { getRiderToday } from '@/lib/rider';

export const dynamic = 'force-dynamic';

/** GET /api/rider/today — the signed-in rider's run + stops for today. */
export async function GET(req: Request) {
  try {
    const p = await requireRider();
    const ctx = ctxFor(req, actorFor(p, 'rider'));
    const today = await getRiderToday(p.riderId, ctx);
    return ok({ ...today, rider: { id: String(p.riderId), name: p.riderName ?? null } });
  } catch (err) {
    return handleRouteError(err);
  }
}
