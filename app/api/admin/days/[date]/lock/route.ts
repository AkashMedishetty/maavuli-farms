import { actorFor, requireStaff } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { isYMD } from '@/lib/cutoff';
import { ValidationError } from '@/lib/errors';
import { lockDayEarly } from '@/lib/manifest';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/days/[date]/lock — freeze today or tomorrow ahead of the cutoff
 * (e.g. to start packing early). Owner, ops. Idempotent.
 */
export async function POST(req: Request, context: { params: Promise<{ date: string }> }) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const { date } = await context.params;
    if (!isYMD(date)) throw new ValidationError('date must be YYYY-MM-DD');
    const lock = await lockDayEarly(date, ctxFor(req, actorFor(p, 'staff')));
    return ok({
      date: lock._id,
      lockedAt: lock.lockedAt.toISOString(),
      stops: lock.stops,
      cowLitres: lock.cowLitres,
      buffaloLitres: lock.buffaloLitres,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
