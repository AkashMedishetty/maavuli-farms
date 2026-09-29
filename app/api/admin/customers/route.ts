import { requireStaff } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';
import { searchCustomers } from '@/lib/admin-customers';

export const dynamic = 'force-dynamic';

/** GET /api/admin/customers?q= — mobile prefix, name or address; max 50. owner, ops, support. */
export async function GET(req: Request) {
  try {
    await requireStaff(['owner', 'ops', 'support']);
    const q = new URL(req.url).searchParams.get('q') ?? '';
    return ok({ customers: await searchCustomers(q) });
  } catch (err) {
    return handleRouteError(err);
  }
}
