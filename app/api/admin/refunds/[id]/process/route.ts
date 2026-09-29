import { ObjectId } from 'mongodb';
import { processRefund } from '@/lib/refunds';
import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok } from '@/lib/api';
import { NotFoundError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** POST /api/admin/refunds/[id]/process — (re)start the Razorpay refund. owner, ops. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const { id } = await context.params;
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new NotFoundError('Refund not found');
    const r = await processRefund(new ObjectId(id), ctxFor(req, actorFor(p, 'staff')));
    return ok({ refund: { id, status: r.status, amountPaise: r.amountPaise, failureReason: r.failureReason ?? null } });
  } catch (err) {
    return handleRouteError(err);
  }
}
