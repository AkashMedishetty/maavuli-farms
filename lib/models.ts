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
 *
 * PLATFORM-CONTRACT.md is the companion to this file: it defines the state machines
 * these status unions belong to, and which module owns each transition.
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
  // ---- platform ----
  settings: 'settings',
  events: 'events',
  dayLocks: 'day_locks',
  riderRuns: 'rider_runs',
  standingRoutes: 'standing_routes',
  riderActions: 'rider_actions',
  photos: 'photos',
  credits: 'credits',
  refunds: 'refunds',
  staff: 'staff',
  tickets: 'tickets',
  outbox: 'outbox',
  inbound: 'inbound_messages',
  jobRuns: 'job_runs',
  disruptions: 'disruptions',
  apiUsage: 'api_usage',
} as const;

/** The only accepted mobile form. Returns null when it is not a valid Indian mobile. */
export function normalizeMobile(input: string): string | null {
  const d = input.replace(/\D/g, '');
  const ten = d.length > 10 ? d.slice(-10) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

/* ------------------------------------------------------------ shared bits -- */

/** Who did something. `id` is a 10-digit mobile for people, a job name for 'system'. */
export interface Actor {
  kind: 'customer' | 'staff' | 'rider' | 'system';
  id: string;
}

export type Lang = 'en' | 'te';

/** A point on the map, {lat,lng} for humans (GeoJSON is [lng,lat] — see lib/geo). */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Structured address parts, captured at onboarding. `DeliveryDetails.address` stays
 * the one-line human string a rider reads out loud; these are the pieces it is built
 * from, kept so the account page can edit them without re-parsing free text.
 */
export interface AddressParts {
  /** flat / house number — required */
  house: string;
  floor?: string;
  /** tower / block / wing */
  building?: string;
  /** society / apartment / street */
  society?: string;
  /** locality / area */
  area?: string;
  pincode?: string;
}

/* ------------------------------------------------------------------ users -- */

export interface User {
  _id?: ObjectId;
  mobile: string;              // 10 digits, normalised
  name?: string;
  email?: string;
  address?: string;
  pincode?: string;
  /** per-mobile credit-ledger lease (lib/credits.withCreditLock) — wall-clock, self-expiring */
  creditLockToken?: string;
  creditLockUntil?: Date;
  /** last-used delivery details, for prefilling a repeat purchase */
  location?: LatLng;
  landmark?: string;
  instructions?: string;
  addressParts?: AddressParts;
  lang?: Lang;                 // absent = 'en'
  /** explicit WhatsApp opt-in (Meta requires it for business-initiated messages) */
  whatsappOptIn?: boolean;
  whatsappOptInAt?: Date;
  /** when WE miss a delivery: add a day at the end (default) or keep the value as credit */
  missedDeliveryPreference?: 'makeup_day' | 'credit';
  /** opt-in: a WhatsApp every morning the milk is delivered, with the doorstep photo */
  notifyDailyDelivered?: boolean;
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
  /** requesting client IP, for the per-IP issue limit */
  ip?: string;
}

export interface Session {
  _id?: ObjectId;
  token: string;               // opaque random, hashed at rest
  mobile: string;
  isAdmin: boolean;
  createdAt: Date;
  expiresAt: Date;
}

/** Staff roles. `owner` also comes from the ADMIN_MOBILES env allowlist (bootstrap). */
export type StaffRole = 'owner' | 'ops' | 'support';

export interface Staff {
  _id?: ObjectId;
  mobile: string;              // 10 digits, unique
  name: string;
  role: StaffRole;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/* ----------------------------------------------------------------- orders -- */

/**
 * created → paid | failed | expired;  failed|expired → paid (a late payment still
 * activates — money received always wins);  paid → partially_refunded | refunded.
 */
export type OrderStatus = 'created' | 'paid' | 'failed' | 'expired' | 'refunded' | 'partially_refunded';

/** why the order exists. Absent on legacy rows = 'new'. */
export type OrderPurpose = 'new' | 'renewal' | 'extra';

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
  /** flat / house, street, area — one line, as a human reads it */
  address: string;
  /** "opposite the water tank" — how deliveries actually get found here */
  landmark?: string;
  /** "hang the bag on the handle", "ring twice" */
  instructions?: string;
  /** exact doorstep. REQUIRED for every new order (checkout rejects without it). */
  location?: LatLng;
  addressParts?: AddressParts;
}

export interface Order {
  _id?: ObjectId;
  /**
   * Razorpay order id. An order paid ENTIRELY from credit never reaches Razorpay; it
   * carries the synthetic id `credit_<24-hex>` so the unique index still holds.
   */
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  mobile: string;
  purpose?: OrderPurpose;
  kind: MilkKind;
  /** plan quantity id from lib/pricing, or 'extra' for purpose 'extra' */
  quantityId: string;
  /** plan tenure id from lib/pricing, or 'extra' for purpose 'extra' */
  tenureId: string;
  /** snapshot of the quote AT PURCHASE TIME — never recompute a past order */
  amountPaise: number;
  perLitrePaise: number;
  days: number;
  litres: number;
  pincode: string;
  /** part of amountPaise paid from the customer's credit balance (debited at creation) */
  creditAppliedPaise?: number;
  /** what Razorpay actually charges: amountPaise - creditAppliedPaise */
  payablePaise?: number;
  /** total refunded so far (Razorpay + manual), paise */
  refundedPaise?: number;
  /** client-generated key per checkout attempt; a retry with the same key returns the same order */
  idempotencyKey?: string;
  /** requested first delivery date (YYYY-MM-DD); activation clamps it to the first open date */
  startDate?: string;
  /** purpose 'renewal': the subscription this one continues after */
  renewsSubscriptionId?: ObjectId;
  /** purpose 'extra': the one-off delivery being bought */
  extra?: { date: string; kind: MilkKind; litres: number; subscriptionId: ObjectId };
  /**
   * Delivery details, captured at checkout and frozen with the order. Optional on
   * the TYPE only so orders written before this field existed still parse; the
   * checkout route requires name, address and location.
   */
  name?: string;
  address?: string;
  landmark?: string;
  instructions?: string;
  location?: LatLng;
  addressParts?: AddressParts;
  whatsappOptIn?: boolean;
  status: OrderStatus;
  createdAt: Date;
  paidAt?: Date;
  failedAt?: Date;
  expiredAt?: Date;
}

/* ---------------------------------------------------------- subscriptions -- */

/**
 * scheduled → active → completed;  scheduled|active → cancelled.
 * 'paused' is LEGACY (read-only): nothing sets it; the migration maps it to active.
 */
export type SubStatus = 'scheduled' | 'active' | 'completed' | 'cancelled' | 'paused';

export interface Subscription {
  _id?: ObjectId;
  orderId: ObjectId;
  mobile: string;
  kind: MilkKind;
  /** litres per day, as a fraction so 0.5 never drifts */
  qtyNum: number;
  qtyDen: number;
  startDate: string;           // YYYY-MM-DD, Asia/Kolkata — the FIRST DELIVERY date
  endDate: string;             // last delivery date; moves when days are appended
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
  instructions?: string;
  addressParts?: AddressParts;
  /**
   * The exact delivery point, for the rider. This is the geo replacement for
   * matching on pincode alone: a pincode in Hyderabad can span several kilometres,
   * which is a delivery instruction nobody can follow.
   */
  location?: { lat: number; lng: number; note?: string };
  /** routing stop identity — see stopKeyOf() below. Set whenever location is set. */
  stopKey?: string;
  /** zone the location falls in (cached at activation / address change) */
  zoneId?: ObjectId;
  /** the renewal queued to start the day after this one ends */
  renewedBy?: ObjectId;
  /** the subscription this one renews */
  renewalOf?: ObjectId;
  createdAt: Date;
  activatedAt?: Date;
  completedAt?: Date;
  /** when the customer (or an admin) cancelled — set only for status 'cancelled' */
  cancelledAt?: Date;
  /** first date with no delivery after a cancellation */
  cancelEffectiveDate?: string;
  cancelledBy?: Actor;
  cancelReason?: string;
  refundId?: ObjectId;
  /**
   * Set in the SAME write that cancels the plan and cleared once the refund and
   * credit side has been settled. A crash or error in between leaves it set, and
   * the tick's settleCancellations step retries it (the refund path is idempotent).
   */
  refundPending?: boolean;
  refundSettledAt?: Date;
}

/* ------------------------------------------------------------- deliveries -- */

/**
 * planned → locked (at the cutoff, manifest frozen) → out_for_delivery (run started)
 *   → delivered | not_delivered;  locked|out_for_delivery → unconfirmed (day close);
 *   unconfirmed → delivered | not_delivered;  locked → cancelled (ops only).
 * A planned row is DELETED (not status-changed) when paused or cancelled — the event
 * log keeps the history.
 *
 * 'scheduled' | 'skipped' | 'failed' are LEGACY (read-only). The platform migration
 * maps them; new code must never write them.
 */
export type DeliveryStatus =
  | 'planned'
  | 'locked'
  | 'out_for_delivery'
  | 'delivered'
  | 'not_delivered'
  | 'unconfirmed'
  | 'cancelled'
  | 'scheduled'
  | 'skipped'
  | 'failed';

/** Reason codes a rider (or ops) records for a delivery that did not happen. */
export type NotDeliveredReason =
  // our side
  | 'out_of_stock'
  | 'vehicle_issue'
  | 'rider_absent'
  | 'disruption'
  | 'spoiled'
  // customer side
  | 'no_access'
  | 'refused'
  | 'customer_asked_skip'
  // unclear — ops decides
  | 'could_not_find'
  | 'other';

export type Fault = 'ours' | 'customer' | 'unknown';

/** Default fault per reason. Ops may override 'unknown' (and only ops may override). */
export const REASON_FAULT: Readonly<Record<NotDeliveredReason, Fault>> = {
  out_of_stock: 'ours',
  vehicle_issue: 'ours',
  rider_absent: 'ours',
  disruption: 'ours',
  spoiled: 'ours',
  no_access: 'customer',
  refused: 'customer',
  customer_asked_skip: 'customer',
  could_not_find: 'unknown',
  other: 'unknown',
};

/** why a delivery row exists. Absent on legacy rows = 'plan'. */
export type DeliverySource = 'plan' | 'makeup' | 'extra';

/** What the rider sees at a stop, frozen at lock so a later edit cannot move a live run. */
export interface StopSnapshot {
  name: string;
  address: string;
  landmark?: string;
  instructions?: string;
  location?: LatLng;
  zoneId?: ObjectId;
  zoneName?: string;
}

export interface DeliveryProof {
  /** storage key of the doorstep photo (see lib/storage) */
  photoKey?: string;
  /** where the phone was when "Delivered" was tapped */
  lat?: number;
  lng?: number;
  accuracyM?: number;
  /** metres between that point and the customer's pin — large values get flagged */
  distanceFromPinM?: number;
  capturedAt?: Date;
  /** needs an ops look: no photo (note instead), or the tap was far from the pin */
  flagged?: boolean;
  /** ops checked a flagged proof and accepted it */
  flagClearedAt?: Date;
  flagClearedBy?: string;
  flagClearNote?: string;
}

/** One row per subscription per date per source — the morning round is read from these. */
export interface Delivery {
  _id?: ObjectId;
  subscriptionId: ObjectId;
  mobile: string;
  date: string;                // YYYY-MM-DD, Asia/Kolkata
  kind: MilkKind;
  litres: number;
  pincode: string;
  status: DeliveryStatus;
  /** absent on legacy rows = 'plan'. New rows MUST set it (it is part of the unique key). */
  source?: DeliverySource;
  /** purpose-'extra' order that paid for this row */
  orderId?: ObjectId;
  note?: string;
  updatedAt?: Date;
  // ---- frozen at lock ----
  lockedAt?: Date;
  /** who runs it today (null = unassigned bucket; ops must assign) */
  riderId?: ObjectId | null;
  runId?: ObjectId;
  /** 1-based position in the run */
  seq?: number;
  stopKey?: string;
  snapshot?: StopSnapshot;
  // ---- outcome ----
  deliveredAt?: Date;
  proof?: DeliveryProof;
  reason?: NotDeliveredReason;
  fault?: Fault;
  reasonNote?: string;
  /** how an our-fault miss was made good */
  resolution?: 'makeup_day' | 'credit' | 'none';
  resolvedBy?: Actor;
  resolvedAt?: Date;
  /** the appended make-up delivery, when resolution is 'makeup_day' */
  compensationDeliveryId?: ObjectId;
  /** the credit entry, when resolution is 'credit' */
  compensationCreditId?: ObjectId;
  /** lease while compensation for this delivery is being written (lib/compensation) */
  compensatingUntil?: Date;
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
  eventId: string;             // x-razorpay-event-id (or provider-prefixed id for other webhooks)
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
  /** 10-digit normalised mobile. A rider signs in to /rider with an OTP to this number. */
  phone?: string;
  active: boolean;
  /** where this rider's run starts; falls back to the farm origin when absent */
  startLocation?: { lat: number; lng: number };
  note?: string;
  lang?: Lang;
  createdAt: Date;
  updatedAt: Date;
}

/* ---------------------------------------------------------- platform ops -- */

/** The single ops settings document (_id 'ops'). All times are HH:MM, Asia/Kolkata. */
export interface OpsSettings {
  _id: 'ops';
  /** changes for a delivery date close at this time on the DAY BEFORE */
  cutoffTime: string;
  /** delivery window shown to customers; drives "late" flags */
  windowStart: string;
  windowEnd: string;
  /** on the delivery day: unmarked deliveries become 'unconfirmed' after this */
  dayCloseTime: string;
  /** doorstep photos older than this are deleted */
  photoRetentionDays: number;
  /** days before endDate to send a renewal reminder */
  renewalReminderDays: number[];
  /** unpaid 'created' orders expire after this */
  unpaidOrderExpiryMinutes: number;
  /** a delivered tap further than this from the pin is flagged */
  proofDistanceFlagM: number;
  updatedAt: Date;
  updatedBy: Actor;
}

/** Materialised lock for a delivery date. Once present, the date is frozen for customers. */
export interface DayLock {
  _id: string;                 // YYYY-MM-DD
  lockedAt: Date;
  lockedBy: Actor;
  /** counts at lock time, for the admin board */
  stops: number;
  cowLitres: number;
  buffaloLitres: number;
  /** set when the day closes (unmarked deliveries → unconfirmed, runs closed) */
  closedAt?: Date;
  unconfirmedAtClose?: number;
}

/**
 * Append-only audit log and customer timeline. Every state transition writes one.
 * `type` is '<entity>.<verb>', e.g. 'subscription.cancelled', 'delivery.delivered'.
 */
export interface DomainEvent {
  _id?: ObjectId;
  entity:
    | 'order'
    | 'subscription'
    | 'delivery'
    | 'refund'
    | 'credit'
    | 'rider_run'
    | 'settings'
    | 'customer'
    | 'message'
    | 'ticket'
    | 'rider'
    | 'zone'
    | 'staff'
    | 'day'
    | 'route';
  entityId: string;
  type: string;
  from?: string;
  to?: string;
  actor: Actor;
  /** customer mobile, when the event belongs to a customer's timeline */
  mobile?: string;
  reason?: string;
  data?: Record<string, unknown>;
  at: Date;
}

/** planned (created at lock) → in_progress (rider starts) → completed (all stops actioned) → closed. */
export type RunStatus = 'planned' | 'in_progress' | 'completed' | 'closed';

export interface RiderRun {
  _id?: ObjectId;
  date: string;
  /** who runs it TODAY (ops can hand it to a cover rider). null = unassigned bucket. */
  riderId: ObjectId | null;
  /** zone owner, when a cover rider is running it */
  territoryRiderId?: ObjectId | null;
  status: RunStatus;
  /** stop keys in visiting order, frozen at lock */
  stopOrder: string[];
  deliveryIds: ObjectId[];
  load: { cowLitres: number; buffaloLitres: number; stops: number };
  routeSource: 'google' | 'local' | 'none';
  totalM?: number;
  startedAt?: Date;
  completedAt?: Date;
  closedAt?: Date;
  returns?: { cowLitres?: number; buffaloLitres?: number; note?: string };
  createdAt: Date;
  updatedAt: Date;
}

/** A rider's standing stop order, re-optimised only when their stop list changes. */
export interface StandingRoute {
  _id?: ObjectId;
  riderId: ObjectId;
  stopOrder: string[];
  source: 'google' | 'local';
  optimizedAt: Date;
  dirty: boolean;
  dirtyReason?: string;
  totalM?: number;
  totalS?: number;
  version: number;
}

/** Idempotency for rider actions replayed from the offline queue. */
export interface RiderAction {
  _id?: ObjectId;
  actionId: string;            // client UUID, unique
  riderId: ObjectId;
  deliveryId?: ObjectId;
  type: 'start_run' | 'delivered' | 'not_delivered' | 'close_run';
  receivedAt: Date;
  result: 'applied' | 'rejected';
  error?: string;
}

/** Doorstep photo metadata. The bytes live in storage (lib/storage); this is the index. */
export interface PhotoRecord {
  _id?: ObjectId;
  key: string;                 // unique storage key
  deliveryId?: ObjectId;
  riderId?: ObjectId;
  mobile?: string;
  date?: string;
  bytes?: number;
  contentType?: string;
  createdAt: Date;
  deletedAt?: Date;
}

/**
 * Credit ledger, immutable. Balance = sum(amountPaise). Positive = credit to the
 * customer, negative = spend. `refundable` marks value that came from PAID days
 * (a missed delivery), which is returned with the balance at cancellation.
 */
export interface CreditEntry {
  _id?: ObjectId;
  mobile: string;
  amountPaise: number;
  kind:
    | 'missed_delivery'
    | 'goodwill'
    | 'makeup_spend'
    | 'extra_spend'
    | 'order_spend'
    | 'order_spend_reversal'
    | 'refund_payout'
    | 'cancellation_balance'
    | 'adjustment';
  refundable: boolean;
  deliveryId?: ObjectId;
  subscriptionId?: ObjectId;
  orderId?: ObjectId;
  refundId?: ObjectId;
  note?: string;
  actor: Actor;
  at: Date;
}

/**
 * pending → processing (Razorpay refund created) → processed | failed;
 * pending|failed → awaiting_upi (payment older than 6 months, or the bank refused)
 *   → paid_manually (ops records the UTR).
 */
export type RefundStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'awaiting_upi' | 'paid_manually';

export interface RefundBreakdown {
  /** what the plan cost (order.amountPaise) */
  planPaise: number;
  /** delivered + locked days, re-priced at the standard 1-month rate */
  chargedDays: number;
  standardDailyPaise: number;
  chargedPaise: number;
  /** planPaise - chargedPaise, floored at 0 */
  balancePaise: number;
  /** unspent refundable credit from this subscription's missed days */
  refundableCreditPaise: number;
  /** of the total, how much goes back to the original payment vs back to credit */
  toSourcePaise: number;
  toCreditPaise: number;
}

export interface Refund {
  _id?: ObjectId;
  mobile: string;
  subscriptionId: ObjectId;
  orderId: ObjectId;
  amountPaise: number;         // toSourcePaise — what leaves the business
  breakdown: RefundBreakdown;
  method: 'razorpay' | 'manual_upi';
  status: RefundStatus;
  razorpayPaymentId?: string;
  razorpayRefundId?: string;
  upiId?: string;
  utr?: string;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TicketKind = 'not_received' | 'spoiled' | 'quantity' | 'other';

export interface Ticket {
  _id?: ObjectId;
  mobile: string;
  kind: TicketKind;
  status: 'open' | 'resolved';
  deliveryId?: ObjectId;
  subscriptionId?: ObjectId;
  note?: string;
  photoKey?: string;
  channel: 'web' | 'whatsapp' | 'staff';
  resolution?: string;
  resolvedBy?: Actor;
  createdAt: Date;
  updatedAt: Date;
}

/** Template names live in lib/notify/templates.ts; this is the outbox row. */
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'logged' | 'suppressed';

export interface OutboundMessage {
  _id?: ObjectId;
  mobile: string;
  template: string;
  lang: Lang;
  params: Record<string, string>;
  /** optional image header (e.g. the doorstep photo), an absolute URL the provider can fetch */
  mediaUrl?: string;
  /** unique — the same business fact is never messaged twice, e.g. 'order_paid:<orderId>' */
  dedupeKey: string;
  status: MessageStatus;
  provider?: string;
  providerMessageId?: string;
  attempts: number;
  nextAttemptAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InboundMessage {
  _id?: ObjectId;
  providerMessageId: string;   // unique
  from: string;                // 10-digit mobile
  type: 'text' | 'button' | 'interactive' | 'location' | 'image' | 'other';
  text?: string;
  payload?: string;
  location?: LatLng;
  receivedAt: Date;
  handled: boolean;
  handledAs?: string;
}

/** Last run of each tick step, plus a lease so overlapping ticks never run a step twice. */
export interface JobRun {
  _id: string;                 // step name
  leaseUntil?: Date;
  lastRunAt?: Date;
  lastOk?: boolean;
  lastError?: string;
  lastReport?: Record<string, unknown>;
}

/** "rain in zone X today": every affected delivery is marked not delivered, our fault. */
export interface Disruption {
  _id?: ObjectId;
  date: string;
  /** empty = every zone */
  zoneIds: ObjectId[];
  reason: string;
  affected: number;
  createdBy: Actor;
  createdAt: Date;
}

/** Daily counters for paid third-party APIs, so a hard cap can be enforced in code too. */
export interface ApiUsage {
  _id: string;                 // '<api>:<YYYY-MM-DD>'
  count: number;
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * The routing identity of a doorstep: one customer at one point. Two subscriptions
 * (cow + buffalo) at the same address are ONE stop; the same customer at two
 * addresses is two. Rounded to ~1 m so a re-saved pin does not fork the stop.
 */
export function stopKeyOf(mobile: string, location: LatLng): string {
  return `${mobile}@${location.lat.toFixed(5)},${location.lng.toFixed(5)}`;
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
  settings: (db: Db) => db.collection<OpsSettings>(COL.settings),
  events: (db: Db) => db.collection<DomainEvent>(COL.events),
  dayLocks: (db: Db) => db.collection<DayLock>(COL.dayLocks),
  riderRuns: (db: Db) => db.collection<RiderRun>(COL.riderRuns),
  standingRoutes: (db: Db) => db.collection<StandingRoute>(COL.standingRoutes),
  riderActions: (db: Db) => db.collection<RiderAction>(COL.riderActions),
  photos: (db: Db) => db.collection<PhotoRecord>(COL.photos),
  credits: (db: Db) => db.collection<CreditEntry>(COL.credits),
  refunds: (db: Db) => db.collection<Refund>(COL.refunds),
  staff: (db: Db) => db.collection<Staff>(COL.staff),
  tickets: (db: Db) => db.collection<Ticket>(COL.tickets),
  outbox: (db: Db) => db.collection<OutboundMessage>(COL.outbox),
  inbound: (db: Db) => db.collection<InboundMessage>(COL.inbound),
  jobRuns: (db: Db) => db.collection<JobRun>(COL.jobRuns),
  disruptions: (db: Db) => db.collection<Disruption>(COL.disruptions),
  apiUsage: (db: Db) => db.collection<ApiUsage>(COL.apiUsage),
};

/**
 * Indexes. Run by scripts/init-db.mjs — idempotent, safe to re-run.
 * The unique ones are load-bearing: `users.mobile` is what stops duplicate
 * accounts, and `webhook_events.eventId` is what stops a retried webhook being
 * processed twice.
 *
 * `deliveries {subscriptionId,date,source}` REPLACES the old {subscriptionId,date}
 * unique index (an extra and a plan delivery may share a date). The platform
 * migration drops the old one after backfilling `source` on legacy rows.
 */
export const INDEXES = [
  { col: COL.users, spec: { mobile: 1 }, options: { unique: true } },
  { col: COL.otps, spec: { mobile: 1 }, options: {} },
  { col: COL.otps, spec: { ip: 1, createdAt: 1 }, options: { sparse: true } },
  { col: COL.otps, spec: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  { col: COL.sessions, spec: { token: 1 }, options: { unique: true } },
  { col: COL.sessions, spec: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  { col: COL.orders, spec: { razorpayOrderId: 1 }, options: { unique: true } },
  { col: COL.orders, spec: { mobile: 1, createdAt: -1 }, options: {} },
  { col: COL.orders, spec: { idempotencyKey: 1 }, options: { unique: true, sparse: true } },
  { col: COL.orders, spec: { status: 1, createdAt: 1 }, options: {} },
  { col: COL.subscriptions, spec: { mobile: 1, status: 1 }, options: {} },
  { col: COL.subscriptions, spec: { orderId: 1 }, options: { unique: true } },
  { col: COL.subscriptions, spec: { status: 1, endDate: 1 }, options: {} },
  { col: COL.subscriptions, spec: { stopKey: 1 }, options: {} },
  { col: COL.deliveries, spec: { date: 1, pincode: 1 }, options: {} },
  { col: COL.deliveries, spec: { subscriptionId: 1, date: 1, source: 1 }, options: { unique: true } },
  { col: COL.deliveries, spec: { date: 1, status: 1 }, options: {} },
  { col: COL.deliveries, spec: { runId: 1, seq: 1 }, options: {} },
  { col: COL.deliveries, spec: { mobile: 1, date: -1 }, options: {} },
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
  { col: COL.riders, spec: { phone: 1 }, options: { unique: true, sparse: true } },
  { col: COL.events, spec: { entityId: 1, at: 1 }, options: {} },
  { col: COL.events, spec: { mobile: 1, at: -1 }, options: {} },
  { col: COL.events, spec: { type: 1, at: -1 }, options: {} },
  { col: COL.riderRuns, spec: { riderId: 1, date: 1 }, options: { unique: true } },
  { col: COL.riderRuns, spec: { date: 1 }, options: {} },
  { col: COL.standingRoutes, spec: { riderId: 1 }, options: { unique: true } },
  { col: COL.riderActions, spec: { actionId: 1 }, options: { unique: true } },
  { col: COL.photos, spec: { key: 1 }, options: { unique: true } },
  { col: COL.photos, spec: { createdAt: 1 }, options: {} },
  { col: COL.credits, spec: { mobile: 1, at: -1 }, options: {} },
  { col: COL.credits, spec: { subscriptionId: 1 }, options: {} },
  { col: COL.refunds, spec: { subscriptionId: 1 }, options: { unique: true } },
  { col: COL.refunds, spec: { status: 1, createdAt: -1 }, options: {} },
  { col: COL.refunds, spec: { razorpayRefundId: 1 }, options: { unique: true, sparse: true } },
  { col: COL.staff, spec: { mobile: 1 }, options: { unique: true } },
  { col: COL.tickets, spec: { status: 1, createdAt: -1 }, options: {} },
  { col: COL.tickets, spec: { mobile: 1, createdAt: -1 }, options: {} },
  { col: COL.outbox, spec: { dedupeKey: 1 }, options: { unique: true } },
  { col: COL.outbox, spec: { status: 1, nextAttemptAt: 1 }, options: {} },
  { col: COL.outbox, spec: { providerMessageId: 1 }, options: { sparse: true } },
  { col: COL.inbound, spec: { providerMessageId: 1 }, options: { unique: true } },
  { col: COL.disruptions, spec: { date: 1 }, options: {} },
] as const;
