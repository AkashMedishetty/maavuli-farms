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
import { principalFor } from '@/lib/roles';
import { getDb } from '@/lib/db';
import { col, type DeliveryStatus, type Rider, type Zone } from '@/lib/models';
import type { MilkKind } from '@/lib/pricing';
import { mapsUrl, pointInPolygon, normalizePoint, type GeoPoint, type GeoPolygon } from './geo';
import { optimizeRoute, directionsUrl, centroid } from './routing';
import { ObjectId } from 'mongodb';

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
 * The admin gate for fulfilment/ops surfaces: owner or ops staff (see lib/roles).
 * Throws `NotAdminError` for every failure — no session, no role, wrong role — so
 * route handlers answer 403 and pages render a "not authorised" state. It never
 * trusts a client flag, a query parameter, or the session's own `isAdmin`: roles
 * are resolved from the env allowlist and the staff collection on every request.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const allow = adminMobiles();
  const session = await getSession();
  if (!session) {
    throw new NotAdminError(allow.length === 0 ? 'Admin is not configured' : 'Not authenticated');
  }
  const p = await principalFor(session.mobile);
  if (p.staffRole !== 'owner' && p.staffRole !== 'ops') {
    throw new NotAdminError(allow.length === 0 ? 'Admin is not configured' : 'Not authorised');
  }
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
  /* ---- who and where, joined from the subscription ----
     Deliveries store only mobile, litres and pincode, so on its own this list told
     a rider "500047, 1 litre" and nothing else. These come from the subscription,
     which is where checkout freezes the delivery details. */
  name?: string;
  address?: string;
  landmark?: string;
  /** deep link the rider can open in any maps app — no API key involved */
  mapsUrl?: string;
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

  /*
   * One extra query, not N. Collect every subscription referenced by today's rows
   * and fetch them in a single $in — a per-delivery lookup would be one round trip
   * per customer on the one screen that has to load fast at 5am.
   */
  const subIds = [...new Set(rows.map(r => String(r.subscriptionId)))]
    .filter(id => ObjectId.isValid(id))
    .map(id => new ObjectId(id));
  const subs = subIds.length
    ? await col.subscriptions(db).find({ _id: { $in: subIds } }).toArray()
    : [];
  const detailsBySub = new Map(subs.map(sub => [String(sub._id), sub]));

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
      ...(() => {
        const sub = detailsBySub.get(String(d.subscriptionId));
        if (!sub) return {};
        return {
          ...(sub.name ? { name: sub.name } : {}),
          ...(sub.address ? { address: sub.address } : {}),
          ...(sub.landmark ? { landmark: sub.landmark } : {}),
          ...(sub.location ? { mapsUrl: mapsUrl(sub.location) } : {}),
        };
      })(),
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

// ------------------------------------------------------------ route plan ----
/**
 * Delivery route optimisation for a day.
 *
 * The morning round grouped by pincode (todaysRound) tells you WHAT to load. This
 * tells a rider the ORDER to drive it in. Zones are assigned to riders
 * (Zone.riderId), so every scheduled stop is bucketed by the zone it falls inside,
 * and each rider's stops are sequenced from an origin — the rider's own start
 * point, else the farm (FARM_ORIGIN_LAT/LNG), else the centre of their stops — by
 * lib/routing (nearest-neighbour + 2-opt). Stops with no saved location can't be
 * placed on a map, so they fall to a separate list the rider still works by hand.
 *
 * All geometry is in-memory: active zones and riders are each read once and matched
 * with the pure `pointInPolygon`, rather than a $geoIntersects per stop, so a round
 * of any realistic size is one query per collection, not one per customer.
 */

interface PlannedStop {
  point: GeoPoint;
  deliveryId: string;
  mobile: string;
  kind: MilkKind;
  litres: number;
  name?: string;
  address?: string;
  landmark?: string;
}

export interface RouteStop {
  deliveryId: string;
  seq: number; // 1-based visiting order
  mobile: string;
  kind: MilkKind;
  litres: number;
  name?: string;
  address?: string;
  landmark?: string;
  location: GeoPoint;
  mapsUrl: string;
  /** metres from the previous point (origin for the first stop) to this stop */
  legM: number;
}

export interface RiderRoute {
  riderId: string | null; // null = a zone with no rider, or a stop in no zone
  riderName: string;
  origin: GeoPoint;
  originLabel: 'rider start' | 'farm' | 'cluster centre';
  stops: RouteStop[];
  totalM: number;
  /** a maps deep link that chains the whole route in order; null if no stops */
  directionsUrl: string | null;
}

export interface UnlocatedStop {
  deliveryId: string;
  mobile: string;
  kind: MilkKind;
  litres: number;
  pincode: string;
  name?: string;
  address?: string;
}

export interface RoutePlan {
  date: string;
  routes: RiderRoute[];
  /** scheduled stops with no saved location — can't be sequenced, listed for hand-routing */
  noLocation: UnlocatedStop[];
}

/** The farm as a route origin, from env. Optional: absent falls back per rider. */
function farmOrigin(): GeoPoint | null {
  return normalizePoint(process.env.FARM_ORIGIN_LAT, process.env.FARM_ORIGIN_LNG);
}

const UNASSIGNED = '__unassigned__';

export async function planRoutes(date: string): Promise<RoutePlan> {
  const db = await getDb();

  // 1. the stops still to deliver on this day
  const rows = await col.deliveries(db).find({ date, status: 'scheduled' }).sort({ mobile: 1 }).toArray();

  // 2. their delivery details (name/address/location) from the subscription
  const subIds = [...new Set(rows.map(r => String(r.subscriptionId)))]
    .filter(id => ObjectId.isValid(id))
    .map(id => new ObjectId(id));
  const subs = subIds.length
    ? await col.subscriptions(db).find({ _id: { $in: subIds } }).toArray()
    : [];
  const subById = new Map(subs.map(s => [String(s._id), s]));

  // 3. active zones (with their rider) and every rider, each read once
  const zones = await col.zones(db).find({ active: true }).toArray();
  const riders = await col.riders(db).find({}).toArray();
  const riderById = new Map<string, Rider>(riders.map(r => [String(r._id), r]));

  const zoneOf = (p: GeoPoint): Zone | null => {
    for (const z of zones) {
      if (pointInPolygon(p, z.geometry as GeoPolygon)) return z;
    }
    return null;
  };

  // 4. bucket the located stops by rider (via zone), collect the rest
  const buckets = new Map<string, PlannedStop[]>();
  const noLocation: UnlocatedStop[] = [];

  for (const d of rows) {
    const sub = subById.get(String(d.subscriptionId));
    const loc = sub?.location;
    if (!loc) {
      noLocation.push({
        deliveryId: String(d._id),
        mobile: d.mobile,
        kind: d.kind,
        litres: d.litres,
        pincode: d.pincode,
        ...(sub?.name ? { name: sub.name } : {}),
        ...(sub?.address ? { address: sub.address } : {}),
      });
      continue;
    }
    const point: GeoPoint = { lat: loc.lat, lng: loc.lng };
    const zone = zoneOf(point);
    const riderId = zone?.riderId ? String(zone.riderId) : null;
    const key = riderId ?? UNASSIGNED;

    const stop: PlannedStop = {
      point,
      deliveryId: String(d._id),
      mobile: d.mobile,
      kind: d.kind,
      litres: d.litres,
      ...(sub?.name ? { name: sub.name } : {}),
      ...(sub?.address ? { address: sub.address } : {}),
      ...(sub?.landmark ? { landmark: sub.landmark } : {}),
    };
    const arr = buckets.get(key);
    if (arr) arr.push(stop);
    else buckets.set(key, [stop]);
  }

  // 5. sequence each bucket from the best available origin
  const farm = farmOrigin();
  const routes: RiderRoute[] = [];

  for (const [key, stops] of buckets) {
    const rider = key === UNASSIGNED ? null : riderById.get(key) ?? null;

    let origin: GeoPoint;
    let originLabel: RiderRoute['originLabel'];
    if (rider?.startLocation) {
      origin = rider.startLocation;
      originLabel = 'rider start';
    } else if (farm) {
      origin = farm;
      originLabel = 'farm';
    } else {
      origin = centroid(stops.map(s => s.point)) ?? stops[0]!.point;
      originLabel = 'cluster centre';
    }

    const { order, legsM, totalM } = optimizeRoute(origin, stops);
    const stopsOut: RouteStop[] = order.map((s, i) => ({
      deliveryId: s.deliveryId,
      seq: i + 1,
      mobile: s.mobile,
      kind: s.kind,
      litres: s.litres,
      ...(s.name ? { name: s.name } : {}),
      ...(s.address ? { address: s.address } : {}),
      ...(s.landmark ? { landmark: s.landmark } : {}),
      location: s.point,
      mapsUrl: mapsUrl(s.point),
      legM: legsM[i] ?? 0,
    }));

    routes.push({
      riderId: rider ? String(rider._id) : null,
      riderName: rider?.name ?? 'Unassigned',
      origin,
      originLabel,
      stops: stopsOut,
      totalM,
      directionsUrl: order.length > 0 ? directionsUrl(origin, order.map(s => s.point)) : null,
    });
  }

  // assigned riders first (alphabetical), the unassigned bucket last
  routes.sort((a, b) => {
    if (a.riderId === null) return 1;
    if (b.riderId === null) return -1;
    return a.riderName.localeCompare(b.riderName);
  });

  return { date, routes, noLocation };
}
