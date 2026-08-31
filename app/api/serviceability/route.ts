import { NextResponse } from 'next/server';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col } from '@/lib/models';
import { isServiceable, normalizePincode } from '@/lib/serviceability';

/**
 * GET /api/serviceability?pincode=NNNNNN
 *
 * Success shape: { pincode, serviceable, area? }
 *
 * The "empty collection" case is answered as a THIRD state, not folded into
 * serviceable:false. "We have not published our delivery area yet" and "we do not
 * deliver to your pincode" are different claims to the customer, and the contract
 * requires we keep them distinct:
 *
 *   { pincode, serviceable: false, unknown: true, message }
 *
 *  - 400 when the pincode is malformed
 *  - 503 when the database is not configured (names the missing vars)
 *  - 503 when the database is configured but unreachable — an outage is not a "no"
 */

// This route reads request-time state; it must never be statically cached.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const raw = url.searchParams.get('pincode') ?? '';
  const pincode = normalizePincode(raw);

  if (pincode === null) {
    return NextResponse.json(
      { error: 'A valid 6-digit pincode is required.' },
      { status: 400 },
    );
  }

  try {
    const db = await getDb();

    // If we deliver NOWHERE yet, say so honestly as "unknown / not published",
    // distinct from a genuine "we do not deliver to you".
    const activeCount = await col.pincodes(db).countDocuments({ active: true }, { limit: 1 });
    if (activeCount === 0) {
      return NextResponse.json({
        pincode,
        serviceable: false,
        unknown: true,
        message: 'Our delivery area is not published yet.',
      });
    }

    const serviceable = await isServiceable(pincode);
    if (!serviceable) {
      return NextResponse.json({ pincode, serviceable: false });
    }

    const row = await col.pincodes(db).findOne({ pincode, active: true });
    return NextResponse.json({
      pincode,
      serviceable: true,
      ...(row?.area ? { area: row.area } : {}),
    });
  } catch (err) {
    // Configuration gap: name the missing variables so it is a bug report, not a mystery.
    if (err instanceof NotConfiguredError) {
      return NextResponse.json(
        {
          error: 'Serviceability is not configured.',
          missing: err.missing,
        },
        { status: 503 },
      );
    }
    // Genuine outage: a wrong "no" and an outage must be distinguishable, so we do
    // NOT answer serviceable:false here.
    return NextResponse.json(
      { error: 'Could not check serviceability right now. Please try again shortly.' },
      { status: 503 },
    );
  }
}
