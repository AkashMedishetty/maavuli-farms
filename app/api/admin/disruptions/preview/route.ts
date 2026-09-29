import { ObjectId } from 'mongodb';
import { actorFor, requireStaff } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { ValidationError } from '@/lib/errors';
import { disruptionPreview } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/disruptions/preview?date=YYYY-MM-DD&zoneIds=a,b — how many
 * deliveries (and customers) a disruption would affect, with no writes. Empty
 * zoneIds = every zone. Staff: owner, ops, support.
 */
export async function GET(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops', 'support']);
    const url = new URL(req.url);
    const date = url.searchParams.get('date');
    if (!date) throw new ValidationError('date is required');
    const raw = (url.searchParams.get('zoneIds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (raw.length > 100) throw new ValidationError('too many zones');
    if (!raw.every(z => ObjectId.isValid(z))) throw new ValidationError('zoneIds must be zone ids');
    const zoneIds = [...new Set(raw)].map(z => new ObjectId(z));
    const preview = await disruptionPreview(date, zoneIds, ctxFor(req, actorFor(p, 'staff')));
    return ok({ ...preview });
  } catch (err) {
    return handleRouteError(err);
  }
}
