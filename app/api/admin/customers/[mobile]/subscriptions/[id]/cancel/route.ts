import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { ConflictError, ValidationError } from '@/lib/errors';
import { subscriptionOfCustomer } from '@/lib/admin-customers';
import { previewCancellationRefund } from '@/lib/refunds';
import { cancelSubscription } from '@/lib/subscriptions';
import { firstOpenDateNow } from '@/lib/daylock';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ mobile: string; id: string }> };

function assertCancellable(status: string): void {
  if (status !== 'scheduled' && status !== 'active') {
    throw new ConflictError(`This plan is ${status}; it cannot be cancelled.`, { status });
  }
}

/**
 * GET — what cancelling this plan now would refund (no writes), plus the date the
 * cancellation takes effect. owner, ops (the action is theirs, so is its preview).
 */
export async function GET(req: Request, { params }: Params) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const { mobile, id } = await params;
    const sub = await subscriptionOfCustomer(mobile, id);
    assertCancellable(sub.status);
    const ctx = ctxFor(req, actorFor(p, 'staff'));
    const [breakdown, effectiveDate] = await Promise.all([previewCancellationRefund(sub._id, ctx), firstOpenDateNow(ctx)]);
    return ok({ preview: { breakdown, effectiveDate } });
  } catch (err) {
    return handleRouteError(err);
  }
}

/** POST {reason} — cancel the plan on the customer's behalf. owner, ops. */
export async function POST(req: Request, { params }: Params) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const { mobile, id } = await params;
    const body = await readJson<{ reason?: unknown }>(req);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 300) {
      throw new ValidationError('A reason is required', ['reason must be 3–300 characters (why the customer is cancelling)']);
    }
    const sub = await subscriptionOfCustomer(mobile, id);
    assertCancellable(sub.status);
    const result = await cancelSubscription(sub._id, ctxFor(req, actorFor(p, 'staff')), { reason: `Staff on behalf of customer: ${reason}` });
    return ok({ result });
  } catch (err) {
    return handleRouteError(err);
  }
}
