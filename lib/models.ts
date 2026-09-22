import type { Collection, Db, ObjectId } from 'mongodb';
import type { MilkKind } from './pricing';

/**
 * Re-exported so backend code has ONE import for its domain types. Without this,
 * `lib/models.ts` had MilkKind only as a local type import and every consumer had
 * to reach past it into lib/pricing — which is exactly the kind of divergence this
 * file exists to prevent.
 */
export type { MilkKind };

/**
 * Every collection shape, defined ONCE.
 *
 * This exists because parallel work on auth, payments, serviceability and admin
 * would otherwise each invent its own `User` and its own `Subscription`, and the
 * divergence only surfaces in production.
 *
 * Two conventions that are not negotiable:
 *
 *  1. MONEY IS PAISE, ALWAYS, AS AN INTEGER. Never a float, never rupees. Field
 *     names end in `Paise` so a mistake is visible at the call site. This matches
 *     lib/pricing.ts, which computes in paise with multiply-before-divide.
 *
 *  2. MOBILE IS 10 DIGITS, NO COUNTRY CODE, NO SPACES. It is the user identity, so
 *     "+91 70752 02177", "07075202177" and "7075202177" must never become three
 *     accounts. Normalise with `normalizeMobile` at every entry point.
 */

export const COL = {
  users: 'users',
  otps: 'otps',
  sessions: 'sessions',
  orders: 'orders',
  subscriptions: 'subscriptions',
  deliveries: 'deliveries',
  pausedDates: 'paused_dates',
  pincodes: 'pincodes',
  webhookEvents: 'webhook_events',
  zones: 'zones',
  riders: 'riders',
} as const;

/** The only accepted mobile form. Returns null when it is not a valid Indian mobile. */
export function normalizeMobile(input: string): string | null {
  const d = input.replace(/\D/g, '');
  const ten = d.length > 10 ? d.slice(-10) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

export interface User {
  _id?: ObjectId;
  mobile: string;              // 10 digits, normalised
  name?: string;
  email?: string;
  address?: string;
  pincode?: string;
  createdAt: Date;
  lastSeenAt?: Date;
}

/** OTPs store a HASH, never the code. A leaked collection must not be a login. */
export interface Otp {
  _id?: ObjectId;
  mobile: string;
  codeHash: string;            // sha256(code + SESSION_SECRET)
  expiresAt: Date;             // TTL index removes it
  attempts: number;            // lock out after 5
  createdAt: Date;
}

export interface Session {
  _id?: ObjectId;
  token: string;               // opaque random, hashed at rest
  mobile: string;
  isAdmin: boolean;
  createdAt: Date;
  expiresAt: Date;
}

export type OrderStatus = 'created' | 'paid' | 'failed' | 'refunded';

/**
 * Everything needed to actually put a bottle on a doorstep.
 *
 * Defined ONCE and reused by Order and Subscription, because these two drifting
 * apart is how a rider ends up with a name but no landmark, or a pincode but no
 * house number. `location` is the exact point; `address` is what a human reads out
 * loud. Both matter — a pin with no flat number is as useless as a flat number with
 * no pin in an unmapped lane.
 */
export interface DeliveryDetails {
  /** who to ask for at the door */
  name: string;
  /** flat / house, street, area — free text, as the customer writes it */
  address: string;
  /** "opposite the water tank" — how deliveries actually get found here */
  landmark?: string;
  /** exact doorstep, when the customer shared it */
  location?: { lat: number; lng: number };
}

export interface Order {
  _id?: ObjectId;
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  mobile: string;
  kind: MilkKind;
  quantityId: string;
  tenureId: string;
  /** snapshot of the quote AT PURCHASE TIME — never recompute a past order */
  amountPaise: number;
  perLitrePaise: number;
  days: number;
  litres: number;
  pincode: string;
  /**
   * Delivery details, captured at checkout and frozen with the order. Optional on
   * the TYPE only so orders written before this field existed still parse; the
   * checkout route requires name and address.
   */
  name?: string;
  address?: string;
  landmark?: string;
  location?: { lat: number; lng: number };
  status: OrderStatus;
  createdAt: Date;
  paidAt?: Date;
}

export type SubStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface Subscription {
  _id?: ObjectId;
  orderId: ObjectId;
  mobile: string;
  kind: MilkKind;
  /** litres per day, as a fraction so 0.5 never drifts */
  qtyNum: number;
  qtyDen: number;
  startDate: string;           // YYYY-MM-DD, Asia/Kolkata
  endDate: string;
  daysTotal: number;
  daysDelivered: number;
  daysPaused: number;
  status: SubStatus;
  /**
   * Total pause days allowed for this subscription, based on plan duration.
   * 1mo=3d, 3mo=20d, 6mo=25d, 1yr=30d. Set at activation, immutable.
   */
  pauseAllowanceDays: number;
  /**
   * Pause days used so far. Increments when customer pauses individual dates.
   * Cannot exceed pauseAllowanceDays.
   */
  pauseUsedDays: number;
  /**
   * Kept for the existing pincode flow. Becomes optional once every subscription
   * carries a `location`; not loosened yet because other backend modules read it
   * unconditionally and a silent empty string is worse than a required field.
   */
  pincode: string;
  /** who to ask for at the door — copied from the order on activation */
  name?: string;
  address?: string;
  landmark?: string;
  /**
   * The exact delivery point, for the rider. This is the geo replacement for
   * matching on pincode alone: a pincode in Hyderabad can span several kilometres,
   * which is a delivery instruction nobody can follow.
   */
  location?: { lat: number; lng: number; note?: string };
  createdAt: Date;
  /** when the customer (or an admin) cancelled — set only for status 'cancelled' */
  cancelledAt?: Date;
}

export type DeliveryStatus = 'scheduled' | 'delivered' | 'skipped' | 'failed';

/** One row per subscription per day — this is what the morning round is read from. */
export interface Delivery {
  _id?: ObjectId;
  subscriptionId: ObjectId;
  mobile: string;
  date: string;                // YYYY-MM-DD, Asia/Kolkata
  kind: MilkKind;
  litres: number;
  pincode: string;
  status: DeliveryStatus;
  note?: string;
  updatedAt?: Date;
}

/**
 * Individual dates paused by the customer. Each date consumes 1 pause day from
 * the subscription's allowance. Deliveries are NOT created for paused dates.
 */
export interface PausedDate {
  _id?: ObjectId;
  subscriptionId: ObjectId;
  mobile: string;
  date: string;                // YYYY-MM-DD, Asia/Kolkata
  /** when the customer selected this pause date */
  pausedAt: Date;
}

/**
 * Serviceability is by PINCODE, authoritatively. Reverse-geocoding a district is
 * fuzzy; a pincode is a lookup. An empty collection means we deliver NOWHERE — the
 * check must never default to yes.
 */
export interface Pincode {
  _id?: ObjectId;
  pincode: string;             // 6 digits
  area?: string;
  active: boolean;
}

/** Razorpay retries webhooks. This is the idempotency guard. */
export interface WebhookEvent {
  _id?: ObjectId;
  eventId: string;             // x-razorpay-event-id
  event: string;
  receivedAt: Date;
  processedAt?: Date;
  error?: string;
}

/**
 * A delivery ZONE — the geo replacement for the pincode list.
 *
 * `shape` is how the admin defined it and is what the admin UI edits. `geometry`
 * is the DERIVED GeoJSON the database actually queries: a circle is stored as a
 * 64-sided polygon so that both circular and hand-drawn zones are answered by one
 * $geoIntersects query instead of two code paths.
 *
 * Both are kept because they answer different questions — "what did the operator
 * mean" and "what does the index match". Recomputing `shape` from `geometry` would
 * lose the operator's intent (a 3km circle becomes an arbitrary 64-gon).
 */
export interface Zone {
  _id?: ObjectId;
  name: string;
  active: boolean;
  shape:
    | { kind: 'circle'; centre: { lat: number; lng: number }; radiusM: number }
    | { kind: 'polygon'; points: { lat: number; lng: number }[] };
  /** GeoJSON Polygon, coordinates in [lng, lat] order. Indexed 2dsphere. */
  geometry: { type: 'Polygon'; coordinates: [number, number][][] };
  /** free text for the rider — landmark, gate code, "ring the bell twice" */
  note?: string;
  /**
   * The rider who runs this zone. Every stop that falls inside the zone is that
   * rider's, which is how the morning round is split without hand-assigning each
   * customer. Optional: an unassigned zone's stops fall to the "unassigned" bucket
   * in the route planner rather than silently vanishing.
   */
  riderId?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A delivery rider. Zones are assigned to riders (Zone.riderId), so a rider owns
 * every stop inside their zones. `startLocation` is where their run begins — the
 * farm by default (see FARM_ORIGIN), or their own start point when set — and is the
 * origin the route optimiser sequences stops from.
 */
export interface Rider {
  _id?: ObjectId;
  name: string;
  /** 10-digit normalised mobile, optional — not every rider is a login */
  phone?: string;
  active: boolean;
  /** where this rider's run starts; falls back to the farm origin when absent */
  startLocation?: { lat: number; lng: number };
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const col = {
  users: (db: Db) => db.collection<User>(COL.users),
  otps: (db: Db) => db.collection<Otp>(COL.otps),
  sessions: (db: Db) => db.collection<Session>(COL.sessions),
  orders: (db: Db) => db.collection<Order>(COL.orders),
  subscriptions: (db: Db) => db.collection<Subscription>(COL.subscriptions),
  deliveries: (db: Db) => db.collection<Delivery>(COL.deliveries),
  pausedDates: (db: Db) => db.collection<PausedDate>(COL.pausedDates),
  pincodes: (db: Db) => db.collection<Pincode>(COL.pincodes),
  webhookEvents: (db: Db) => db.collection<WebhookEvent>(COL.webhookEvents),
  zones: (db: Db) => db.collection<Zone>(COL.zones),
  riders: (db: Db) => db.collection<Rider>(COL.riders),
};

/**
 * Indexes. Run by scripts/init-db.mjs — idempotent, safe to re-run.
 * The unique ones are load-bearing: `users.mobile` is what stops duplicate
 * accounts, and `webhook_events.eventId` is what stops a retried webhook being
 * processed twice.
 */
export const INDEXES = [
  { col: COL.users, spec: { mobile: 1 }, options: { unique: true } },
  { col: COL.otps, spec: { mobile: 1 }, options: {} },
  { col: COL.otps, spec: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  { col: COL.sessions, spec: { token: 1 }, options: { unique: true } },
  { col: COL.sessions, spec: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  { col: COL.orders, spec: { razorpayOrderId: 1 }, options: { unique: true } },
  { col: COL.orders, spec: { mobile: 1, createdAt: -1 }, options: {} },
  { col: COL.subscriptions, spec: { mobile: 1, status: 1 }, options: {} },
  { col: COL.deliveries, spec: { date: 1, pincode: 1 }, options: {} },
  { col: COL.deliveries, spec: { subscriptionId: 1, date: 1 }, options: { unique: true } },
  { col: COL.pausedDates, spec: { subscriptionId: 1, date: 1 }, options: { unique: true } },
  { col: COL.pausedDates, spec: { mobile: 1, date: 1 }, options: {} },
  { col: COL.pincodes, spec: { pincode: 1 }, options: { unique: true } },
  { col: COL.webhookEvents, spec: { eventId: 1 }, options: { unique: true } },
  // 2dsphere is what makes $geoIntersects usable; without it the point-in-zone
  // query is a collection scan and errors on anything but tiny data.
  { col: COL.zones, spec: { geometry: '2dsphere' }, options: {} },
  { col: COL.zones, spec: { active: 1 }, options: {} },
  { col: COL.zones, spec: { riderId: 1 }, options: {} },
  { col: COL.riders, spec: { active: 1 }, options: {} },
] as const;
