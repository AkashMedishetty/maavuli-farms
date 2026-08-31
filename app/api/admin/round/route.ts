import { NextResponse } from 'next/server';
import { getDb, NotConfiguredError } from '@/lib/db';
import { requireAdmin, NotAdminError, todaysRound } from '@/lib/admin';

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PINCODE_RE = /^\d{6}$/;

/**
 * The morning round for a given day as JSON — pincode-grouped with litre totals.
 * The page renders the round server-side, so this endpoint exists for a client
 * refresh / a future dispatch tool. Admin-gated like every admin surface.
 *
 * `date` is YYYY-MM-DD in Asia/Kolkata (the round is a local-calendar concept);
 * the caller supplies it, because "today" on the client and "today" on the server
 * can differ across midnight IST.
 */
export async function GET(req: Request): Promise<NextResponse> {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdminError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const url = new URL(req.url);
  const date = url.searchParams.get('date');
  const pincode = url.searchParams.get('pincode') ?? undefined;

  if (!date || !DATE_RE.test(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
  }
  if (pincode !== undefined && !PINCODE_RE.test(pincode)) {
    return NextResponse.json({ error: 'pincode must be 6 digits' }, { status: 400 });
  }

  try {
    // touch the db first so a missing config answers 503, not an empty round
    await getDb();
    const round = await todaysRound(date, pincode);
    return NextResponse.json(round);
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
