import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { requireSession, UnauthorizedError } from '@/lib/auth';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col } from '@/lib/models';
import { pauseSubscription } from '@/lib/subscriptions';

/**
 * POST /api/subscriptions/:id/pause  { fromDate: "YYYY-MM-DD" }
 *
 * Pauses the customer's own subscription from fromDate. The ownership check
 * (session.mobile === subscription.mobile) is the entire security of this
 * endpoint: without it any logged-in user could pause anyone's deliveries.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'invalid subscription id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }
  const fromDate = (body as { fromDate?: unknown })?.fromDate;
  if (typeof fromDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    return NextResponse.json({ error: 'fromDate is required as YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const session = await requireSession();
    const _id = new ObjectId(id);

    const db = await getDb();
    const sub = await col.subscriptions(db).findOne({ _id }, { projection: { mobile: 1 } });
    if (!sub) return NextResponse.json({ error: 'subscription not found' }, { status: 404 });

    // OWN subscription only. Admin is allowed, everyone else must match.
    if (!session.isAdmin && session.mobile !== sub.mobile) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const updated = await pauseSubscription(_id, fromDate);
    return NextResponse.json({ subscription: updated });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (err instanceof NotConfiguredError) {
    return NextResponse.json({ error: 'service unavailable', missing: err.missing }, { status: 503 });
  }
  const message = err instanceof Error ? err.message : 'unknown error';
  return NextResponse.json({ error: message }, { status: 400 });
}
