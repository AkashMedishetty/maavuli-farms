import { ObjectId } from 'mongodb';
import { setRefundUpi } from '@/lib/refunds';
import { actorFor, requireSignedIn } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { NotFoundError, ValidationError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** POST /api/account/refunds/[id]/upi {upiId} — own awaiting_upi refund only (404 otherwise). */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const p = await requireSignedIn();
    const { id } = await context.params;
    if (!ObjectId.isValid(id) || !/^[a-f0-9]{24}$/i.test(id)) throw new NotFoundError('Refund not found');
    const body = await readJson<{ upiId?: unknown }>(req);
    if (typeof body.upiId !== 'string' || body.upiId.length > 300) throw new ValidationError('upiId is required', ['upiId must be a string']);
    const r = await setRefundUpi(new ObjectId(id), p.mobile, body.upiId, ctxFor(req, actorFor(p, 'customer')));
    return ok({ refund: { id, status: r.status, amountPaise: r.amountPaise, upiId: r.upiId ?? null } });
  } catch (err) {
    return handleRouteError(err);
  }
}
