import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok } from '@/lib/api';
import { NotFoundError } from '@/lib/errors';
import { customerDetail } from '@/lib/admin-customers';

export const dynamic = 'force-dynamic';

/** GET /api/admin/customers/[mobile] — the full customer record. owner, ops, support. */
export async function GET(req: Request, context: { params: Promise<{ mobile: string }> }) {
  try {
    const p = await requireStaff(['owner', 'ops', 'support']);
    const { mobile } = await context.params;
    const detail = await customerDetail(mobile, ctxFor(req, actorFor(p, 'staff')));
    if (!detail) throw new NotFoundError('Customer not found');
    return ok({ customer: detail });
  } catch (err) {
    return handleRouteError(err);
  }
}
