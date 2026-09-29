import { ObjectId } from 'mongodb';
import { recordManualRefund } from '@/lib/refunds';
import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { NotFoundError, ValidationError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/refunds/[id]/manual {utr, upiId?, reason?} — record a UPI payout ops
 * made. owner, ops. upiId omitted → the customer's saved UPI id ('upi_required' when
 * none); a different upiId needs a reason of 5–300 chars ('upi_override_reason').
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const { id } = await context.params;
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new NotFoundError('Refund not found');
    const body = await readJson<{ upiId?: unknown; utr?: unknown; reason?: unknown }>(req);
    const issues: string[] = [];
    if (typeof body.utr !== 'string' || body.utr.length > 60) issues.push('utr must be a string');
    if (body.upiId !== undefined && body.upiId !== null && (typeof body.upiId !== 'string' || body.upiId.length > 300)) issues.push('upiId must be a string');
    if (body.reason !== undefined && body.reason !== null && (typeof body.reason !== 'string' || body.reason.length > 1000)) issues.push('reason must be a string');
    if (issues.length) throw new ValidationError('utr is required', issues);
    const r = await recordManualRefund(
      new ObjectId(id),
      {
        utr: body.utr as string,
        ...(typeof body.upiId === 'string' ? { upiId: body.upiId } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      },
      ctxFor(req, actorFor(p, 'staff')),
    );
    return ok({ refund: { id, status: r.status, amountPaise: r.amountPaise, upiId: r.upiId ?? null, utr: r.utr ?? null } });
  } catch (err) {
    return handleRouteError(err);
  }
}
