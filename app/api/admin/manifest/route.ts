import { requireStaff } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { istYMD, isYMD } from '@/lib/cutoff';
import { ValidationError } from '@/lib/errors';
import { getManifest } from '@/lib/manifest';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/manifest?date=YYYY-MM-DD — the day's runs, stops and load.
 * Frozen runs once the date is locked; a no-write preview before the cutoff.
 * Staff: owner, ops, support.
 */
export async function GET(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops', 'support']);
    const ctx = ctxFor(req, { kind: 'staff', id: p.mobile });
    const raw = new URL(req.url).searchParams.get('date');
    const date = raw ?? istYMD(ctx.now);
    if (!isYMD(date)) throw new ValidationError('date must be YYYY-MM-DD');
    return ok({ manifest: await getManifest(date, ctx) });
  } catch (err) {
    return handleRouteError(err);
  }
}
