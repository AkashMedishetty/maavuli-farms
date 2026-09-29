import { ObjectId } from 'mongodb';
import { actorFor, requireStaff } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { ValidationError } from '@/lib/errors';
import { optimizeStandingRoute } from '@/lib/route-plan';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/routes/[riderId]/optimize — rebuild one rider's standing route
 * now (owner, ops). Uses Google when configured and under the cost caps, otherwise
 * the local solver; the response says which.
 */
export async function POST(req: Request, context: { params: Promise<{ riderId: string }> }) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const { riderId } = await context.params;
    if (!ObjectId.isValid(riderId)) throw new ValidationError('riderId must be a valid id');
    const ctx = ctxFor(req, actorFor(p, 'staff'));
    const route = await optimizeStandingRoute(new ObjectId(riderId), ctx);
    return ok({
      riderId,
      stops: route.stopOrder.length,
      source: route.source,
      optimizedAt: route.optimizedAt.toISOString(),
      ...(route.totalM !== undefined ? { totalM: route.totalM } : {}),
      ...(route.totalS !== undefined ? { totalS: route.totalS } : {}),
      version: route.version,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
