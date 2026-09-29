import { actorFor, requireStaff } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { listExceptions } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/exceptions?date=YYYY-MM-DD — the ops exceptions queue:
 * unconfirmed deliveries, not-delivered with fault 'unknown', and flagged proofs.
 * Without `date`: the last 7 days up to today. Staff: owner, ops, support.
 */
export async function GET(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops', 'support']);
    const raw = new URL(req.url).searchParams.get('date');
    const res = await listExceptions(raw ?? undefined, ctxFor(req, actorFor(p, 'staff')));
    return ok({ ...res });
  } catch (err) {
    return handleRouteError(err);
  }
}
