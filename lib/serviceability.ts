import { getDb } from './db';
import { col, type Pincode, type Zone } from './models';
import { toGeoJSON, type GeoPoint } from './geo';

/**
 * Serviceability is decided by PINCODE, authoritatively, against the `pincodes`
 * collection. Two rules from the contract drive everything here:
 *
 *  1. An empty collection means we deliver NOWHERE. `isServiceable` must return
 *     false, never true, when nothing is active. Defaulting to yes would promise a
 *     delivery we cannot make.
 *
 *  2. A wrong "no" and an outage are DIFFERENT claims. If the database cannot be
 *     reached, we do NOT swallow it into a serviceable=false — we let the error
 *     propagate so the route can answer 503. "We do not deliver there" and "we
 *     could not check" must be distinguishable to the caller.
 */

/** Accept only a clean 6-digit pincode. Returns null for anything else. */
export function normalizePincode(input: string): string | null {
  // Strip nothing silently — a value with stray characters is a client bug, not a
  // pincode we should guess at. Only pure 6-digit input is a pincode.
  const trimmed = input.trim();
  return /^\d{6}$/.test(trimmed) ? trimmed : null;
}

/**
 * True only when the given pincode has an ACTIVE row. Returns false for an unknown
 * pincode and for an empty collection. Throws (does not return false) when the
 * database is unreachable — the route turns that into a 503.
 */
export async function isServiceable(pincode: string): Promise<boolean> {
  const normalized = normalizePincode(pincode);
  if (normalized === null) return false;

  // getDb() throws NotConfiguredError when env is missing and throws on a genuine
  // connection failure. We deliberately do NOT catch: an outage must surface as an
  // outage, not masquerade as "not serviceable".
  const db = await getDb();
  const match = await col.pincodes(db).findOne({ pincode: normalized, active: true });
  return match !== null;
}

/** Every active service area. Empty array when we deliver nowhere. Throws on outage. */
export async function listServiceable(): Promise<Pincode[]> {
  const db = await getDb();
  return col
    .pincodes(db)
    .find({ active: true })
    .sort({ pincode: 1 })
    .toArray();
}


/* ------------------------------------------------------------------ geo ---- */

/**
 * The geo replacement for pincode matching. A Hyderabad pincode can span several
 * kilometres, which is not a delivery instruction anyone can follow — a zone plus
 * an exact point is.
 *
 * The two invariants at the top of this file apply UNCHANGED, and they are the
 * reason this is not just a findOne:
 *
 *  1. No active zones means we deliver NOWHERE. Never true by default.
 *  2. An outage THROWS rather than returning false, so "we do not deliver there"
 *     stays distinguishable from "we could not check".
 *
 * The query is $geoIntersects against a 2dsphere index, which asks the question we
 * actually have — "does this point fall inside a stored zone" — rather than
 * $centerSphere, which asks the inverse and cannot express a hand-drawn area.
 */
export async function zoneForPoint(point: GeoPoint): Promise<Zone | null> {
  const db = await getDb();
  return col.zones(db).findOne({
    active: true,
    geometry: {
      $geoIntersects: {
        // GeoJSON is [lng, lat]; toGeoJSON is the only thing allowed to build this
        $geometry: { type: 'Point', coordinates: toGeoJSON(point) },
      },
    },
  });
}

/** True only when the point falls in an active zone. Throws on outage. */
export async function isServiceablePoint(point: GeoPoint): Promise<boolean> {
  return (await zoneForPoint(point)) !== null;
}

/** How many zones we currently serve. 0 means nowhere — the honest default. */
export async function activeZoneCount(): Promise<number> {
  const db = await getDb();
  return col.zones(db).countDocuments({ active: true });
}

/** Every active zone, for the admin list and the map. Throws on outage. */
export async function listZones(): Promise<Zone[]> {
  const db = await getDb();
  return col.zones(db).find({}).sort({ name: 1 }).toArray();
}
