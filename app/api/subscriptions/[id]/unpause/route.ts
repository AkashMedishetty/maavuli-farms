import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { col } from '@/lib/models';
import { unpauseDates } from '@/lib/pause';

/**
 * POST /api/subscriptions/[id]/unpause
 *
 * Re-enable previously paused dates. Request body:
 * {
 *   "dates": ["2026-09-15", "2026-09-16"]
 * }
 *
 * Only allowed for dates that:
 * - Are currently paused
 * - Haven't passed yet
 * - Respect 4 PM cutoff (can't unpause tomorrow after 4 PM today)
 */
export async function POST(
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

    // Verify subscription belongs to this user
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

    const body = await request.json();
    const { dates } = body;

    if (!Array.isArray(dates) || dates.length === 0) {
      return NextResponse.json(
        { error: 'dates must be a non-empty array' },
        { status: 400 }
      );
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    for (const date of dates) {
      if (typeof date !== 'string' || !dateRegex.test(date)) {
        return NextResponse.json(
          { error: `Invalid date format: ${date}. Use YYYY-MM-DD.` },
          { status: 400 }
        );
      }
    }

    const result = await unpauseDates(subscriptionId, dates);

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    console.error('POST /api/subscriptions/[id]/unpause error:', err);
    return NextResponse.json(
      { error: err.message || 'Server error' },
      { status: 500 }
    );
  }
}
