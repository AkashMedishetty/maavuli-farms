import { NextResponse } from 'next/server';
import { getDb, NotConfiguredError } from '@/lib/db';
import { requireAdmin, NotAdminError, activeSubscriptions } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/**
 * Every currently-active subscription, as JSON. Admin-gated. Read-only: this
 * surface reports who is on the roll, it does not mutate a subscription's state
 * (that belongs to the payment/lifecycle owner, not the fulfilment panel).
 */
export async function GET(): Promise<NextResponse> {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdminError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  try {
    await getDb();
    const subscriptions = await activeSubscriptions();
    return NextResponse.json({ subscriptions });
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return NextResponse.json(
        { error: 'Database not configured', missing: err.missing },
        { status: 503 },
      );
    }
    throw err;
  }
}
