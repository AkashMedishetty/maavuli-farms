import { ok, readJson, handleRouteError } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { actorFor, requireStaff } from '@/lib/roles';
import { getOpsSettings, updateOpsSettings } from '@/lib/settings';

/**
 * GET /api/admin/settings — owner, ops, support.
 * PUT /api/admin/settings — owner only; body is a partial settings patch
 * (unknown keys and invalid values → 400 with issues).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireStaff(['owner', 'ops', 'support']);
    const settings = await getOpsSettings();
    return ok({ settings });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PUT(req: Request) {
  try {
    const p = await requireStaff(['owner']);
    const patch = await readJson(req);
    const settings = await updateOpsSettings(patch, ctxFor(req, actorFor(p, 'staff')));
    return ok({ settings });
  } catch (err) {
    return handleRouteError(err);
  }
}
