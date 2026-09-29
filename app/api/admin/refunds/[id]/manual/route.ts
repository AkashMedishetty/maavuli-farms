import { ObjectId } from 'mongodb';
import { recordManualRefund } from '@/lib/refunds';
import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { NotFoundError, ValidationError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** POST /api/admin/refunds/[id]/manual {upiId, utr} — record a UPI payout ops made. owner, ops. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const { id } = await context.params;
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new NotFoundError('Refund not found');
    const body = await readJson<{ upiId?: unknown; utr?: unknown }>(req);
    if (typeof body.upiId !== 'string' || typeof body.utr !== 'string' || body.upiId.length > 300 || body.utr.length > 60) {
      throw new ValidationError('upiId and utr are required', ['upiId and utr must be strings']);
    }
    const r = await recordManualRefund(new ObjectId(id), { upiId: body.upiId, utr: body.utr }, ctxFor(req, actorFor(p, 'staff')));
    return ok({ refund: { id, status: r.status, amountPaise: r.amountPaise, upiId: r.upiId ?? null, utr: r.utr ?? null } });
  } catch (err) {
    return handleRouteError(err);
  }
}
