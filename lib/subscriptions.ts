import { MongoServerError, type ObjectId } from 'mongodb';
import { getDb } from './db';
import { col, normalizeMobile, type Delivery, type Subscription } from './models';
import type { ObjectId as ObjectIdType } from 'mongodb';
import type { OpCtx } from './clock';

/* ================================================================ PLATFORM ==
 * OWNER: B1 (subscriptions & orders). The four functions below are the contract
 * other agents code against — keep their signatures and replace the stub bodies.
 * cancelSubscription (further down) also changes to (id, ctx, opts) per the
 * contract; B1 updates its only caller, app/api/subscriptions/[id]/cancel.
 * ========================================================================== */

/**
 * Append `days` delivery days after the subscription's current endDate (source
 * 'plan' for pause shifts, 'makeup' for our-fault compensation) and move endDate.
 * If a renewal is queued (renewedBy) and has not started, shift it by the same
 * number of days so the two never overlap. Returns the new endDate and dates added.
 */
export async function extendSubscription(
  subscriptionId: ObjectIdType,
  days: number,
  source: 'plan' | 'makeup',
  ctx: OpCtx,
): Promise<{ newEndDate: string; appended: string[] }> {
  void subscriptionId;
  void days;
  void source;
  void ctx;
  throw new Error('not implemented: extendSubscription (owner B1)');
}

/** Tick step: scheduled → active on startDate. */
export async function activateDueSubscriptions(ctx: OpCtx): Promise<{ activated: number }> {
  void ctx;
  throw new Error('not implemented: activateDueSubscriptions (owner B1)');
}

/** Tick step: active → completed once endDate has passed and nothing is left to deliver. */
export async function completeEndedSubscriptions(ctx: OpCtx): Promise<{ completed: number }> {
  void ctx;
  throw new Error('not implemented: completeEndedSubscriptions (owner B1)');
}

/** The customer's current plan chain for a kind: what a renewal would continue after. */
export async function renewalTarget(
  mobile: string,
  subscriptionId: ObjectIdType,
): Promise<{ subscription: Subscription; renewStartDate: string } | null> {
  void mobile;
  void subscriptionId;
  throw new Error('not implemented: renewalTarget (owner B1)');
}

/**
 * Subscription lifecycle: turning a paid order into a term of daily deliveries,
 * and the pause / resume / skip operations that reshape that term.
 *
 * THE HARD PART IS DATES. Every date in this module is a `YYYY-MM-DD` string in
 * Asia/Kolkata. A milk round is a local-calendar concept: the van goes out on the
 * morning of the 5th, not "the 24 hours after midnight UTC". If we let a `Date`'s
 * UTC day drive a delivery's date, the round rolls over at 05:30 IST and a day's
 * deliveries silently vanish (the 30th produces two rows, the 31st produces none).
 *
 * So we never read `.getUTCDate()` or hand-roll a `+5:30` offset — DST-free India
 * makes the offset look safe, but the *arithmetic* of adding days to a shifted
 * timestamp still crosses midnight in the wrong place. Instead we format through
 * `Intl.DateTimeFormat(timeZone: 'Asia/Kolkata')` and do all day-stepping in the
 * plain-calendar space of a UTC-noon anchor, which cannot be pushed across a day
 * boundary by any single-digit-hour offset.
 */

/* ------------------------------------------------------------------ dates -- */

const KOLKATA_FMT = new Intl.DateTimeFormat('en-CA', {
  // en-CA renders as YYYY-MM-DD, which is exactly the wire format we store.
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Format any instant to the calendar date it falls on in Asia/Kolkata. */
export function kolkataYMD(d: Date): string {
  return KOLKATA_FMT.format(d);
}

/** Today's date in Asia/Kolkata. */
export function todayKolkata(): string {
  return kolkataYMD(new Date());
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turn a validated `YYYY-MM-DD` into a UTC-noon `Date`. Noon, not midnight, so the
 * anchor sits 12h from either day boundary — no timezone shift within +/-11h can
 * bump it onto a neighbouring calendar day, which makes day arithmetic exact.
 */
function ymdToNoonUTC(ymd: string): Date {
  if (!YMD_RE.test(ymd)) throw new Error(`not a YYYY-MM-DD date: "${ymd}"`);
  const parts = ymd.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  // Reject impossible dates the regex admits, e.g. 2025-02-30 -> normalises away.
  if (kolkataYMD(date) !== ymd) throw new Error(`not a real calendar date: "${ymd}"`);
  return date;
}

/** Add `n` whole days to a `YYYY-MM-DD` string, returning a `YYYY-MM-DD` string. */
export function addDays(ymd: string, n: number): string {
  const anchor = ymdToNoonUTC(ymd);
  anchor.setUTCDate(anchor.getUTCDate() + n);
  return kolkataYMD(anchor);
}

/**
 * Inclusive count of calendar days from `start` to `end`, e.g. the 1st to the 1st
 * is 1 day, the 1st to the 3rd is 3. Uses the noon anchors so a month/year
 * boundary in between cannot introduce an off-by-one.
 */
export function daysInclusive(start: string, end: string): number {
  const a = ymdToNoonUTC(start).getTime();
  const b = ymdToNoonUTC(end).getTime();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((b - a) / MS_PER_DAY) + 1;
}

/** Every `YYYY-MM-DD` from `start` for `count` consecutive days. */
export function dateRange(start: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(addDays(start, i));
  return out;
}

/* --------------------------------------------------------------- activate -- */

/**
 * Calculate pause allowance based on subscription tenure.
 * 1 month (30d) = 3 days, 3 months (90d) = 20 days, 6 months (180d) = 25 days, 1 year (360d) = 30 days.
 */
function calculatePauseAllowance(daysTotal: number): number {
  if (daysTotal <= 30) return 3;
  if (daysTotal <= 90) return 20;
  if (daysTotal <= 180) return 25;
  return 30; // 1 year+
}

/**
 * Turn a PAID order into a live subscription plus one delivery row per day.
 *
 * Imported by the Razorpay webhook agent with EXACTLY this signature — do not
 * change it. Razorpay retries webhooks, so this MUST be idempotent: a second call
 * for the same order neither creates a second subscription nor duplicates
 * deliveries. We do not check-then-write (that races two concurrent retries);
 * instead the unique indexes `orders`-derived `subscriptions` lookup and the
 * unique `deliveries {subscriptionId, date}` index are the safety net, and we
 * swallow the duplicate-key error.
 */
export async function activateSubscriptionForOrder(orderId: ObjectId): Promise<void> {
  const db = await getDb();
  const order = await col.orders(db).findOne({ _id: orderId });
  if (!order) throw new Error(`activate: order ${orderId.toHexString()} not found`);
  if (order.status !== 'paid') {
    throw new Error(`activate: order ${orderId.toHexString()} is "${order.status}", not paid`);
  }

  // The subscription's term starts on the paid day, in Kolkata time. paidAt is the
  // authoritative instant; fall back to now only if a legacy order lacks it.
  const startDate = kolkataYMD(order.paidAt ?? new Date());
  const daysTotal = order.days;
  const endDate = addDays(startDate, daysTotal - 1);

  // qtyNum/qtyDen come from the order's litres-over-days. litres is the WHOLE-term
  // total (e.g. 0.5 L/day x 30 = 15), so per-day = litres/days as an exact
  // fraction. Both are small integers here (num=litres*1, den=days), reduced so
  // 15/30 stores as 1/2 rather than drifting.
  const g = gcd(Math.round(order.litres), order.days);
  const qtyNum = Math.round(order.litres) / g;
  const qtyDen = order.days / g;
  const perDayLitres = order.litres / order.days;

  const mobile = normalizeMobile(order.mobile);
  if (!mobile) throw new Error(`activate: order has invalid mobile "${order.mobile}"`);

  // ---- 1. subscription row, idempotent on orderId --------------------------
  // There is no unique index on subscriptions.orderId in the shared model, so we
  // guard with a findOneAndUpdate upsert keyed on orderId: a retry finds the
  // existing row instead of inserting a duplicate. This is the one place a
  // check-and-write is unavoidable, and the upsert makes it atomic.
  const now = new Date();
  const subDoc: Omit<Subscription, '_id'> = {
    orderId,
    mobile,
    kind: order.kind,
    qtyNum,
    qtyDen,
    startDate,
    endDate,
    daysTotal,
    daysDelivered: 0,
    daysPaused: 0,
    pauseAllowanceDays: calculatePauseAllowance(daysTotal),
    pauseUsedDays: 0,
    status: 'active',
    pincode: order.pincode,
    // Delivery details travel with the subscription, not just the order: the
    // fulfilment panel and the rider read the subscription, and an order is a
    // payment record they should never have to join against.
    ...(order.name ? { name: order.name } : {}),
    ...(order.address ? { address: order.address } : {}),
    ...(order.landmark ? { landmark: order.landmark } : {}),
    ...(order.location ? { location: order.location } : {}),
    createdAt: now,
  };

  const res = await col.subscriptions(db).findOneAndUpdate(
    { orderId },
    { $setOnInsert: subDoc },
    { upsert: true, returnDocument: 'after' },
  );
  const sub = res;
  if (!sub?._id) throw new Error(`activate: could not upsert subscription for order ${orderId.toHexString()}`);
  const subscriptionId = sub._id;

  // ---- 2. one delivery per day, idempotent on {subscriptionId, date} -------
  // Rely on the unique index rather than reading first. On a retry every insert
  // collides and is skipped; the first run inserts them all. `ordered: false`
  // lets a partially-completed first run be finished by the retry.
  //
  // Check for paused dates and exclude them from delivery generation
  const pausedDates = await col
    .pausedDates(db)
    .find({ subscriptionId })
    .toArray();
  const pausedDateSet = new Set(pausedDates.map(p => p.date));

  const allDates = dateRange(startDate, daysTotal);
  const deliveryDates = allDates.filter(d => !pausedDateSet.has(d));

  const rows: Omit<Delivery, '_id'>[] = deliveryDates.map(date => ({
    subscriptionId,
    mobile,
    date,
    kind: order.kind,
    litres: perDayLitres,
    pincode: order.pincode,
    status: 'scheduled' as const,
    updatedAt: now,
  }));

  try {
    if (rows.length > 0) {
      await col.deliveries(db).insertMany(rows, { ordered: false });
    }
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Every duplicate is an already-created delivery from a prior attempt — the
    // desired end state. Any non-duplicate write error would have re-thrown above.
  }
}

/* ------------------------------------------------------------------ pause -- */
/*
 * Pause/resume/skip USED to live here as three separate operations: an indefinite
 * whole-subscription pause (status → 'paused'), its resume, and a single-day skip.
 * They have been retired in favour of ONE customer-facing mechanism — the
 * calendar, allowance-limited, per-date pause in lib/pause.ts — which the account
 * page and the /pause, /unpause and /calendar routes use. That module is now the
 * only writer of pause state: it removes each paused day's delivery, appends a
 * make-up day, tracks the allowance in `pauseUsedDays`, and keeps the subscription
 * ACTIVE. The old status='paused' path had no HTTP route left and its resume could
 * never fire, so keeping it was two mechanisms disagreeing about the same field.
 *
 * (SubStatus still lists 'paused' so legacy rows and the roll job's status filter
 * keep parsing; nothing sets it any more.)
 */

/* ----------------------------------------------------------------- cancel -- */

export interface CancelResult {
  status: 'cancelled';
  /** the day service stops — today, in Asia/Kolkata */
  endedOn: string;
  /** days already delivered on this subscription */
  daysDelivered: number;
  /** future scheduled days that were removed — the unused, paid-for days a refund
      would be calculated against, once the refund policy is set */
  daysRemaining: number;
}

/**
 * Cancel a subscription: stop all future deliveries and mark it terminal.
 *
 * Every still-`scheduled` delivery from today onward is removed (so nothing else
 * goes out), any future paused dates are cleared (moot once cancelled), the status
 * becomes `cancelled` and the end date is brought to today. Delivered rows are left
 * untouched — they are the history a refund is reckoned from.
 *
 * This does NOT compute or issue a refund: the refund amount is a policy the client
 * has not published yet, and inventing one is worse than none. The result carries
 * `daysRemaining` (the unused paid days) so a refund can be reckoned once that
 * policy exists. Idempotent: cancelling an already-cancelled subscription is a
 * no-op that returns the same shape.
 */
export async function cancelSubscription(id: ObjectId): Promise<CancelResult> {
  const db = await getDb();
  const sub = await col.subscriptions(db).findOne({ _id: id });
  if (!sub) throw new Error(`cancel: subscription ${id.toHexString()} not found`);
  if (sub.status === 'completed') throw new Error('cancel: subscription is already completed');

  if (sub.status === 'cancelled') {
    return { status: 'cancelled', endedOn: sub.endDate, daysDelivered: sub.daysDelivered, daysRemaining: 0 };
  }

  const today = todayKolkata();

  // Stop future deliveries. Only `scheduled` rows from today onward — a day already
  // delivered stays as history.
  const del = await col.deliveries(db).deleteMany({
    subscriptionId: id,
    status: 'scheduled',
    date: { $gte: today },
  });
  const daysRemaining = del.deletedCount ?? 0;

  // Future pause selections no longer mean anything.
  await col.pausedDates(db).deleteMany({ subscriptionId: id, date: { $gte: today } });

  const res = await col.subscriptions(db).findOneAndUpdate(
    { _id: id },
    { $set: { status: 'cancelled', endDate: today, cancelledAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!res) throw new Error(`cancel: subscription ${id.toHexString()} vanished`);

  return { status: 'cancelled', endedOn: today, daysDelivered: res.daysDelivered, daysRemaining };
}

/* -------------------------------------------------------------- upcoming -- */

export interface UpcomingDelivery {
  subscriptionId: string;
  date: string;
  kind: Delivery['kind'];
  litres: number;
  status: Delivery['status'];
  pincode: string;
}

/**
 * The next `days` of scheduled deliveries for a customer's mobile, across all
 * their active subscriptions, oldest date first. This is the customer's
 * "what's coming" view.
 */
export async function upcomingDeliveries(mobile: string, days: number): Promise<UpcomingDelivery[]> {
  const m = normalizeMobile(mobile);
  if (!m) throw new Error(`upcoming: invalid mobile "${mobile}"`);
  if (!Number.isInteger(days) || days <= 0) throw new Error('upcoming: days must be a positive integer');

  const db = await getDb();
  const from = todayKolkata();
  const to = addDays(from, days - 1);

  const rows = await col
    .deliveries(db)
    .find({ mobile: m, status: 'scheduled', date: { $gte: from, $lte: to } })
    .sort({ date: 1 })
    .toArray();

  return rows.map(r => ({
    subscriptionId: r.subscriptionId.toHexString(),
    date: r.date,
    kind: r.kind,
    litres: r.litres,
    status: r.status,
    pincode: r.pincode,
  }));
}

/* ----------------------------------------------------------------- utils -- */

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

function isDuplicateKeyError(err: unknown): boolean {
  // MongoBulkWriteError from insertMany wraps individual E11000s; a single insert
  // throws MongoServerError with code 11000 directly. Cover both.
  if (err instanceof MongoServerError && err.code === 11000) return true;
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: number; writeErrors?: Array<{ code?: number }> };
    if (e.code === 11000) return true;
    if (Array.isArray(e.writeErrors) && e.writeErrors.every(w => w.code === 11000)) return true;
  }
  return false;
}
