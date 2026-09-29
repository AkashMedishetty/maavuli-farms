import { actorFor, requireStaff } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { systemStatus } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/system — tick health (last run / error of every step, leases) and
 * the lock state of today and tomorrow. Staff: owner, ops, support.
 */
export async function GET(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops', 'support']);
    return ok({ ...(await systemStatus(ctxFor(req, actorFor(p, 'staff')))) });
  } catch (err) {
    return handleRouteError(err);
  }
}
