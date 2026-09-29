import { requireStaff } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';
import { requestNow } from '@/lib/clock';
import { listRouteSummaries } from '@/lib/route-plan';
import { googleRoutesConfigured, googleUsage } from '@/lib/google-routes';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/routes — every active rider's standing route, plus today's
 * Google usage against the caps (staff: owner, ops, support).
 */
export async function GET(req: Request) {
  try {
    await requireStaff(['owner', 'ops', 'support']);
    const [routes, usage] = await Promise.all([listRouteSummaries(), googleUsage(requestNow(req))]);
    return ok({
      routes,
      google: {
        configured: googleRoutesConfigured(),
        usageToday: usage.today,
        usageMonth: usage.month,
        dailyCap: usage.dailyCap,
        monthlyCap: usage.monthlyCap,
      },
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
