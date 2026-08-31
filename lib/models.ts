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
  pincodes: 'pincodes',
  webhookEvents: 'webhook_events',
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
  address?: string;
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
  pincode: string;
  address?: string;
  createdAt: Date;
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

export const col = {
  users: (db: Db) => db.collection<User>(COL.users),
  otps: (db: Db) => db.collection<Otp>(COL.otps),
  sessions: (db: Db) => db.collection<Session>(COL.sessions),
  orders: (db: Db) => db.collection<Order>(COL.orders),
  subscriptions: (db: Db) => db.collection<Subscription>(COL.subscriptions),
  deliveries: (db: Db) => db.collection<Delivery>(COL.deliveries),
  pincodes: (db: Db) => db.collection<Pincode>(COL.pincodes),
  webhookEvents: (db: Db) => db.collection<WebhookEvent>(COL.webhookEvents),
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
  { col: COL.pincodes, spec: { pincode: 1 }, options: { unique: true } },
  { col: COL.webhookEvents, spec: { eventId: 1 }, options: { unique: true } },
] as const;
