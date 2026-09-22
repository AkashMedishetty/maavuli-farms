import { NextResponse } from 'next/server';
import { NotConfiguredError } from '@/lib/db';
import { requireAdmin, NotAdminError, planRoutes } from '@/lib/admin';

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/admin/route?date=YYYY-MM-DD
 *
 * The optimised delivery routes for a day: each rider's scheduled stops sequenced
 * from their origin, with per-leg distances and a maps directions link, plus the
 * stops that have no saved location (listed for hand-routing). Admin-gated like
 * every admin surface. The page renders this server-side; the endpoint exists for a
 * client refresh and for a future in-van view.
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

  const date = new URL(req.url).searchParams.get('date');
  if (!date || !DATE_RE.test(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const plan = await planRoutes(date);
    return NextResponse.json(plan);
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return NextResponse.json({ error: 'Database not configured', missing: err.missing }, { status: 503 });
    }
    return NextResponse.json({ error: 'Could not plan routes.' }, { status: 503 });
  }
}
