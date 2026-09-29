import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { addStaff, listStaff } from '@/lib/admin-customers';

export const dynamic = 'force-dynamic';

/** GET /api/admin/staff — env owners (fixed) + staff rows. owner only. */
export async function GET() {
  try {
    await requireStaff(['owner']);
    return ok({ staff: await listStaff() });
  } catch (err) {
    return handleRouteError(err);
  }
}

/** POST /api/admin/staff {mobile, name, role: owner|ops|support}. owner only. */
export async function POST(req: Request) {
  try {
    const p = await requireStaff(['owner']);
    const body = await readJson<{ mobile?: unknown; name?: unknown; role?: unknown }>(req);
    const staff = await addStaff({ mobile: body.mobile, name: body.name, role: body.role }, ctxFor(req, actorFor(p, 'staff')));
    return ok({ staff }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
