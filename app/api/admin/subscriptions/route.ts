import { requireStaff } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';
import { activeSubscriptions } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/subscriptions — every currently-active subscription (read-only).
 * Staff: owner, ops, support. Lifecycle changes belong to lib/subscriptions.
 */
export async function GET() {
  try {
    await requireStaff(['owner', 'ops', 'support']);
    return ok({ subscriptions: await activeSubscriptions() });
  } catch (err) {
    return handleRouteError(err);
  }
}
