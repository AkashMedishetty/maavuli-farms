import { ok, readJson, handleRouteError } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { actorFor, requireSignedIn } from '@/lib/roles';
import { ConflictError, ValidationError } from '@/lib/errors';
import { firstOpenDateNow } from '@/lib/daylock';
import { previewCancellationRefund } from '@/lib/refunds';
import { cancelSubscription } from '@/lib/subscriptions';
import { ownSubscription } from '../../_lib';

/**
 * GET  /api/subscriptions/[id]/cancel → { breakdown, effectiveDate } (no writes)
 * POST /api/subscriptions/[id]/cancel   { confirm: true, reason? } → CancelResult
 *
 * Own plan only (404 otherwise). Cancellation is effective from the first open date;
 * the refund follows the published policy (lib/refunds).
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const p = await requireSignedIn();
    const sub = await ownSubscription(context.params, p);
    if (sub.status !== 'scheduled' && sub.status !== 'active' && sub.status !== 'paused') {
      throw new ConflictError(`This plan is already ${sub.status}.`);
    }
    const ctx = ctxFor(req, actorFor(p, 'customer'));
    const [breakdown, effectiveDate] = await Promise.all([
      previewCancellationRefund(sub._id, ctx),
      firstOpenDateNow(ctx),
    ]);
    return ok({ breakdown, effectiveDate });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const p = await requireSignedIn();
    const sub = await ownSubscription(context.params, p);
    const body = await readJson<{ confirm?: unknown; reason?: unknown }>(req);
    if (body.confirm !== true) throw new ValidationError('Send { "confirm": true } to cancel this plan.');
    if (body.reason !== undefined && typeof body.reason !== 'string') throw new ValidationError('reason must be text');
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    if (sub.status === 'completed') throw new ConflictError('This plan has already ended.');
    const result = await cancelSubscription(sub._id, ctxFor(req, actorFor(p, 'customer')), reason ? { reason } : undefined);
    return ok({ ...result });
  } catch (err) {
    return handleRouteError(err);
  }
}
