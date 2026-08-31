import { NextResponse } from 'next/server';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col } from '@/lib/models';
import {
  isServiceable,
  normalizePincode,
  zoneForPoint,
  activeZoneCount,
} from '@/lib/serviceability';
import { normalizePoint, mapsUrl } from '@/lib/geo';

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

  /*
   * GEO BRANCH — added alongside the pincode branch, deliberately not replacing it.
   *
   * The delivery area is moving from pincodes to drawn zones, but a flag day would
   * break every caller at once. So a request carrying lat+lng is answered from the
   * zones collection, anything else falls through to the original pincode path, and
   * both keep the same three-state contract: serviceable / not serviceable /
   * unknown-because-nothing-is-published.
   */
  const latRaw = url.searchParams.get('lat');
  const lngRaw = url.searchParams.get('lng');
  if (latRaw !== null || lngRaw !== null) {
    const point = normalizePoint(latRaw, lngRaw);
    if (!point) {
      return NextResponse.json(
        { error: 'lat and lng must both be valid coordinates.' },
        { status: 400 },
      );
    }
    try {
      await getDb();

      // Same honesty rule as pincodes: no zones published is a THIRD state, not a
      // refusal to deliver.
      if ((await activeZoneCount()) === 0) {
        return NextResponse.json({
          point,
          serviceable: false,
          unknown: true,
          message: 'Our delivery area is not published yet.',
        });
      }

      const zone = await zoneForPoint(point);
      if (!zone) return NextResponse.json({ point, serviceable: false });

      return NextResponse.json({
        point,
        serviceable: true,
        zone: zone.name,
        // handed to the rider, so the exact doorstep is navigable
        mapsUrl: mapsUrl(point),
      });
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        return NextResponse.json(
          { error: 'Serviceability is not configured.', missing: err.missing },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { error: 'Could not check serviceability right now. Please try again shortly.' },
        { status: 503 },
      );
    }
  }

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
