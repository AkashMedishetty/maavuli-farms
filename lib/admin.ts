/**
 * Admin data access, server-only.
 *
 * Two rules from the contract shape everything here:
 *
 *  1. Admin is an env allowlist of mobiles (ADMIN_MOBILES), verified server-side on
 *     every request. An empty allowlist means admin is UNREACHABLE — never a
 *     default-open panel. `requireAdmin` is the single choke point; nothing below
 *     it runs for an unauthenticated or non-allowlisted caller.
 *
 *  2. Money is read back, never re-derived. `revenueSummary` sums the paise stored
 *     on each paid order at purchase time. It must not call quote() — a past order
 *     is a historical fact, and recomputing it would silently rewrite revenue if a
 *     rate ever changes.
 */

import { getSession } from '@/lib/auth';
import { adminMobiles } from '@/lib/env';
import { getDb } from '@/lib/db';
import { col, type DeliveryStatus } from '@/lib/models';
import type { MilkKind } from '@/lib/pricing';

/** A session the caller can trust is an allowlisted admin. */
export interface AdminSession {
  mobile: string;
  isAdmin: true;
}

export class NotAdminError extends Error {
  constructor(msg = 'Admin access required') {
    super(msg);
    this.name = 'NotAdminError';
  }
}

/** True only when at least one mobile is configured. Empty list = unreachable. */
export function adminConfigured(): boolean {
  return adminMobiles().length > 0;
}

/**
 * The one gate. Throws `NotAdminError` unless the caller has a session whose mobile
 * is in ADMIN_MOBILES. Route handlers turn the throw into a 403; the page renders
 * an "admin not configured" / "not authorised" state. It never trusts a client
 * flag, a query parameter, or the session's own `isAdmin` alone — the env
 * allowlist is the authority, so a compromised session that set isAdmin still
 * fails the mobile check.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const allow = adminMobiles();
  if (allow.length === 0) throw new NotAdminError('Admin is not configured');

  const session = await getSession();
  if (!session) throw new NotAdminError('Not authenticated');
  if (!allow.includes(session.mobile)) throw new NotAdminError('Not authorised');

  return { mobile: session.mobile, isAdmin: true };
}

// ------------------------------------------------------------------ round ----

/** One customer's line in the round for a pincode. */
export interface RoundDelivery {
  deliveryId: string;
  mobile: string;
  kind: MilkKind;
  litres: number;
  status: DeliveryStatus;
  note?: string;
}

export interface RoundPincode {
  pincode: string;
  litresTotal: number;
  deliveries: RoundDelivery[];
}

export interface TodaysRound {
  date: string;
  litresTotal: number;
  pincodes: RoundPincode[];
}

/**
 * The morning fulfilment list: every delivery scheduled/actioned for `date`,
 * grouped by pincode then mobile, with a per-pincode litre total and an overall
 * total. This is what someone loading a van reads.
 *
 * `date` is a YYYY-MM-DD Asia/Kolkata string, matching how deliveries are stored —
 * a milk round is a local-calendar concept, so we never touch UTC here.
 */
export async function todaysRound(date: string, pincode?: string): Promise<TodaysRound> {
  const db = await getDb();
  const filter: { date: string; pincode?: string } = { date };
  if (pincode) filter.pincode = pincode;

  const rows = await col
    .deliveries(db)
    .find(filter)
    .sort({ pincode: 1, mobile: 1 })
    .toArray();

  const byPincode = new Map<string, RoundPincode>();
  let litresTotal = 0;

  for (const d of rows) {
    litresTotal += d.litres;
    let group = byPincode.get(d.pincode);
    if (!group) {
      group = { pincode: d.pincode, litresTotal: 0, deliveries: [] };
      byPincode.set(d.pincode, group);
    }
    group.litresTotal += d.litres;
    group.deliveries.push({
      deliveryId: String(d._id),
      mobile: d.mobile,
      kind: d.kind,
      litres: d.litres,
      status: d.status,
      note: d.note,
    });
  }

  const pincodes = [...byPincode.values()].sort((a, b) => a.pincode.localeCompare(b.pincode));
  return { date, litresTotal, pincodes };
}

// ---------------------------------------------------------- subscriptions ----

export interface ActiveSubscriptionRow {
  subscriptionId: string;
  mobile: string;
  kind: MilkKind;
  litresPerDay: number;
  startDate: string;
  endDate: string;
  daysTotal: number;
  daysDelivered: number;
  pincode: string;
}

/** Every subscription currently active, most recently started first. */
export async function activeSubscriptions(): Promise<ActiveSubscriptionRow[]> {
  const db = await getDb();
  const rows = await col
    .subscriptions(db)
    .find({ status: 'active' })
    .sort({ startDate: -1 })
    .toArray();

  return rows.map(s => ({
    subscriptionId: String(s._id),
    mobile: s.mobile,
    kind: s.kind,
    // stored as an exact fraction so 0.5 L never drifts; present the litre value
    litresPerDay: s.qtyNum / s.qtyDen,
    startDate: s.startDate,
    endDate: s.endDate,
    daysTotal: s.daysTotal,
    daysDelivered: s.daysDelivered,
    pincode: s.pincode,
  }));
}

// --------------------------------------------------------------- revenue ----

export interface RevenueSummary {
  paidOrders: number;
  /** sum of the AMOUNT STORED on each paid order, in paise — never re-derived */
  totalPaise: number;
}

/**
 * Total of all paid orders, in paise. Sums the `amountPaise` snapshot each order
 * carries from purchase time. Display formatting (formatINR) happens in the view,
 * not here — this returns the integer paise so nothing downstream rounds twice.
 */
export async function revenueSummary(): Promise<RevenueSummary> {
  const db = await getDb();
  const paid = await col.orders(db).find({ status: 'paid' }).toArray();
  const totalPaise = paid.reduce((sum, o) => sum + o.amountPaise, 0);
  return { paidOrders: paid.length, totalPaise };
}

/** The delivery statuses an admin may set — the writable subset of the union. */
export const SETTABLE_DELIVERY_STATUSES = ['delivered', 'skipped', 'failed'] as const;
export type SettableDeliveryStatus = (typeof SETTABLE_DELIVERY_STATUSES)[number];

export function isSettableDeliveryStatus(v: unknown): v is SettableDeliveryStatus {
  return typeof v === 'string' && (SETTABLE_DELIVERY_STATUSES as readonly string[]).includes(v);
}
