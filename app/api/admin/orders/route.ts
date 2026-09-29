import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok } from '@/lib/api';
import { ValidationError } from '@/lib/errors';
import { abandonedCheckouts, listOrders, ORDER_STATUSES } from '@/lib/admin-customers';
import type { OrderStatus } from '@/lib/models';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/orders?status=&cursor=  — orders newest first, 50 per page
 * (`nextCursor` when a full page came back).
 * GET /api/admin/orders?status=abandoned — the abandoned-checkout call list.
 * owner, ops, support.
 */
export async function GET(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops', 'support']);
    const url = new URL(req.url);
    const status = url.searchParams.get('status');
    if (status === 'abandoned') {
      return ok({ abandoned: await abandonedCheckouts(ctxFor(req, actorFor(p, 'staff'))) });
    }
    if (status !== null && status !== '' && !ORDER_STATUSES.includes(status as OrderStatus)) {
      throw new ValidationError('Unknown status', [`status must be one of ${ORDER_STATUSES.join(', ')}, abandoned`]);
    }
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const res = await listOrders({ ...(status ? { status: status as OrderStatus } : {}), ...(cursor ? { cursor } : {}) });
    return ok({ orders: res.orders, nextCursor: res.nextCursor });
  } catch (err) {
    return handleRouteError(err);
  }
}
