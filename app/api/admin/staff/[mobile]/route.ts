import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { updateStaff } from '@/lib/admin-customers';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/admin/staff/[mobile] {role?, name?, active?}. owner only.
 * Env owners are fixed; nobody can deactivate or demote themselves.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ mobile: string }> }) {
  try {
    const p = await requireStaff(['owner']);
    const { mobile } = await params;
    const body = await readJson<{ role?: unknown; name?: unknown; active?: unknown }>(req);
    const staff = await updateStaff(
      mobile,
      {
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
      p.mobile,
      ctxFor(req, actorFor(p, 'staff')),
    );
    return ok({ staff });
  } catch (err) {
    return handleRouteError(err);
  }
}
