import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col } from '@/lib/models';
import { cancelSubscription } from '@/lib/subscriptions';

/**
 * POST /api/subscriptions/[id]/cancel
 *
 * Cancels the caller's own subscription (or any, for an admin): future deliveries
 * stop, the subscription is marked cancelled and ends today. Irreversible — the
 * client shows a confirmation before calling this. No refund is computed here; the
 * refund follows the published cancellation policy (/legal/refunds), and the
 * response carries `daysRemaining` (unused paid days) for reckoning it.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { id } = await context.params;
    if (!ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'invalid subscription id' }, { status: 400 });
    }
    const subscriptionId = new ObjectId(id);

    const db = await getDb();
    const sub = await col.subscriptions(db).findOne({ _id: subscriptionId }, { projection: { mobile: 1 } });
    if (!sub) {
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 });
    }
    if (!session.isAdmin && sub.mobile !== session.mobile) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const result = await cancelSubscription(subscriptionId);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return NextResponse.json({ error: 'service unavailable', missing: err.missing }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
