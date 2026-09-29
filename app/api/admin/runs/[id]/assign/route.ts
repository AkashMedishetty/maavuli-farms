import { ObjectId } from 'mongodb';
import { actorFor, requireStaff } from '@/lib/roles';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { ValidationError } from '@/lib/errors';
import { reassignRun } from '@/lib/manifest';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/runs/[id]/assign  { riderId } — hand a day's run to a cover rider
 * (the zone owner is off, or the unassigned bucket needs someone). Owner, ops.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const { id } = await context.params;
    if (!ObjectId.isValid(id)) throw new ValidationError('run id must be a valid id');
    const body = await readJson<{ riderId?: unknown }>(req);
    if (typeof body.riderId !== 'string' || !ObjectId.isValid(body.riderId)) {
      throw new ValidationError('riderId must be a valid id');
    }
    const run = await reassignRun(new ObjectId(id), new ObjectId(body.riderId), ctxFor(req, actorFor(p, 'staff')));
    return ok({ runId: id, riderId: run.riderId ? run.riderId.toHexString() : null, date: run.date, status: run.status });
  } catch (err) {
    return handleRouteError(err);
  }
}
