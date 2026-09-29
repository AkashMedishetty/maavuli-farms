import { ObjectId } from 'mongodb';
import { actorFor, requireStaff } from '@/lib/roles';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { addDaysYMD, istYMD, isYMD } from '@/lib/cutoff';
import { ValidationError } from '@/lib/errors';
import { createDisruption, listDisruptions } from '@/lib/disruptions';

export const dynamic = 'force-dynamic';

/** GET /api/admin/disruptions?from=&to= — recent disruptions (staff). Defaults to the last 30 days. */
export async function GET(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops', 'support']);
    const ctx = ctxFor(req, actorFor(p, 'staff'));
    const url = new URL(req.url);
    const today = istYMD(ctx.now);
    const from = url.searchParams.get('from') ?? addDaysYMD(today, -30);
    const to = url.searchParams.get('to') ?? addDaysYMD(today, 7);
    if (!isYMD(from) || !isYMD(to)) throw new ValidationError('from/to must be YYYY-MM-DD');
    const rows = await listDisruptions(from, to);
    return ok({
      disruptions: rows.map(d => ({
        id: d._id!.toHexString(),
        date: d.date,
        zoneIds: d.zoneIds.map(z => z.toHexString()),
        reason: d.reason,
        affected: d.affected,
        createdBy: d.createdBy,
        createdAt: d.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

/**
 * POST /api/admin/disruptions { date, zoneIds?: string[], reason } — mark every
 * affected delivery not delivered (our fault, compensated) and notify customers.
 * Owner, ops.
 */
export async function POST(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const body = await readJson<{ date?: unknown; zoneIds?: unknown; reason?: unknown }>(req);
    if (typeof body.date !== 'string') throw new ValidationError('date is required');
    if (typeof body.reason !== 'string') throw new ValidationError('reason is required');
    const zoneIds: ObjectId[] = [];
    if (body.zoneIds !== undefined) {
      if (!Array.isArray(body.zoneIds) || !body.zoneIds.every(z => typeof z === 'string' && ObjectId.isValid(z))) {
        throw new ValidationError('zoneIds must be an array of zone ids');
      }
      for (const z of body.zoneIds as string[]) zoneIds.push(new ObjectId(z));
    }
    const res = await createDisruption({ date: body.date, zoneIds, reason: body.reason }, ctxFor(req, actorFor(p, 'staff')));
    return ok({ id: res.disruption._id!.toHexString(), affected: res.affected, customers: res.customers, failed: res.failed });
  } catch (err) {
    return handleRouteError(err);
  }
}
