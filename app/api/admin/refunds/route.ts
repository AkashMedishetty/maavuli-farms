import { getDb } from '@/lib/db';
import { col, type RefundStatus } from '@/lib/models';
import { requireStaff } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';
import { ValidationError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

const STATUSES: readonly RefundStatus[] = ['pending', 'processing', 'processed', 'failed', 'awaiting_upi', 'paid_manually'];

/** GET /api/admin/refunds?status=awaiting_upi — newest first, up to 200. */
export async function GET(req: Request) {
  try {
    await requireStaff(['owner', 'ops', 'support']);
    const status = new URL(req.url).searchParams.get('status');
    if (status !== null && !STATUSES.includes(status as RefundStatus)) {
      throw new ValidationError('Unknown status', [`status must be one of ${STATUSES.join(', ')}`]);
    }
    const db = await getDb();
    const rows = await col
      .refunds(db)
      .find(status ? { status: status as RefundStatus } : {})
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return ok({
      refunds: rows.map(r => ({
        id: r._id?.toHexString() ?? null,
        mobile: r.mobile,
        subscriptionId: r.subscriptionId.toHexString(),
        orderId: r.orderId.toHexString(),
        amountPaise: r.amountPaise,
        breakdown: r.breakdown,
        method: r.method,
        status: r.status,
        razorpayRefundId: r.razorpayRefundId ?? null,
        upiId: r.upiId ?? null,
        utr: r.utr ?? null,
        failureReason: r.failureReason ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
