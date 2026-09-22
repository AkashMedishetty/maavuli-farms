import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { col } from '@/lib/models';
import { getSubscriptionCalendar } from '@/lib/pause';

/**
 * GET /api/subscriptions/[id]/calendar
 *
 * Returns calendar information for a subscription including:
 * - Start/end dates
 * - Pause allowance and usage
 * - List of paused dates
 * - Earliest pausable date (respecting 4 PM cutoff)
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { id } = await context.params;
    const subscriptionId = new ObjectId(id);

    // Verify the subscription belongs to this user
    const db = await getDb();
    const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });

    if (!sub) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    if (sub.mobile !== session.mobile) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const calendar = await getSubscriptionCalendar(subscriptionId);

    if (!calendar) {
      return NextResponse.json(
        { error: 'Could not load calendar' },
        { status: 500 }
      );
    }

    return NextResponse.json(calendar);
  } catch (err: any) {
    console.error('GET /api/subscriptions/[id]/calendar error:', err);
    return NextResponse.json(
      { error: err.message || 'Server error' },
      { status: 500 }
    );
  }
}
