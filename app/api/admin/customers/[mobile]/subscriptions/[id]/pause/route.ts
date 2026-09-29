import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { ValidationError } from '@/lib/errors';
import { subscriptionOfCustomer } from '@/lib/admin-customers';
import { pauseDates } from '@/lib/pause';

export const dynamic = 'force-dynamic';

/**
 * POST {dates: YYYY-MM-DD[]} — pause dates on the customer's behalf (same rules as
 * the customer: open dates only, within the allowance). owner, ops.
 */
export async function POST(req: Request, { params }: { params: Promise<{ mobile: string; id: string }> }) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const { mobile, id } = await params;
    const body = await readJson<{ dates?: unknown }>(req);
    if (!Array.isArray(body.dates) || !body.dates.every((d): d is string => typeof d === 'string')) {
      throw new ValidationError('dates must be a list of YYYY-MM-DD strings');
    }
    const sub = await subscriptionOfCustomer(mobile, id);
    // lib/pause validates format, count, open dates, term and allowance
    const result = await pauseDates(sub._id, body.dates, ctxFor(req, actorFor(p, 'staff')));
    return ok({ result: { ...result } });
  } catch (err) {
    return handleRouteError(err);
  }
}
