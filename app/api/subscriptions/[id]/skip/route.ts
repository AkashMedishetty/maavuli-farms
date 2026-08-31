import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { requireSession, UnauthorizedError } from '@/lib/auth';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col } from '@/lib/models';
import { skipDelivery } from '@/lib/subscriptions';

/**
 * POST /api/subscriptions/:id/skip  { date: "YYYY-MM-DD" }
 *
 * Skips one day of the customer's own subscription. Ownership check
 * (session.mobile === subscription.mobile) is the whole security of this route.
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
  const date = (body as { date?: unknown })?.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date is required as YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const session = await requireSession();
    const _id = new ObjectId(id);

    const db = await getDb();
    const sub = await col.subscriptions(db).findOne({ _id }, { projection: { mobile: 1 } });
    if (!sub) return NextResponse.json({ error: 'subscription not found' }, { status: 404 });

    if (!session.isAdmin && session.mobile !== sub.mobile) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const updated = await skipDelivery(_id, date);
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
