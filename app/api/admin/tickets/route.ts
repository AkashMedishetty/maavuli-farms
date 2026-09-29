/**
 * GET /api/admin/tickets?status=&mobile=  — staff read of support tickets. OWNER: B6.
 * Access: owner, ops, support (admin reads, §7).
 */

import { requireStaff } from '@/lib/roles';
import { listTickets } from '@/lib/tickets';
import { ok, handleRouteError } from '@/lib/api';
import type { Ticket } from '@/lib/models';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireStaff(['owner', 'ops', 'support']);
    const url = new URL(req.url);
    const statusParam = url.searchParams.get('status');
    const mobile = url.searchParams.get('mobile') ?? undefined;

    const status: Ticket['status'] | undefined =
      statusParam === 'open' || statusParam === 'resolved' ? statusParam : undefined;

    const tickets = await listTickets({ ...(mobile ? { mobile } : {}), ...(status ? { status } : {}) });
    return ok({ tickets });
  } catch (err) {
    return handleRouteError(err);
  }
}
