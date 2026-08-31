import { getDb } from './db';
import { col, type Pincode } from './models';

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
