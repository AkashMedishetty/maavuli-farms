import { MongoServerError, ObjectId } from 'mongodb';
import { getDb } from './db';
import {
  col,
  normalizeMobile,
  stopKeyOf,
  type Delivery,
  type Subscription,
} from './models';
import { systemCtx, type OpCtx } from './clock';
import { assertTransition, SUB_TRANSITIONS } from './transitions';
import { recordEvent } from './events';
import { firstOpenDateNow } from './daylock';
import { DateLockedError } from './errors';
import { zoneForPoint } from './serviceability';
import { markRouteDirty } from './route-plan';
import { createCancellationRefund } from './refunds';
import { enqueueMessage } from './notify';
import { formatINR } from './pricing';

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

function ymdToNoonUTC(ymd: string): Date {
  if (!YMD_RE.test(ymd)) throw new Error(`not a YYYY-MM-DD date: "${ymd}"`);
  const parts = ymd.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  if (kolkataYMD(date) !== ymd) throw new Error(`not a real calendar date: "${ymd}"`);
  return date;
}

/** Add `n` whole days to a `YYYY-MM-DD` string, returning a `YYYY-MM-DD` string. */
export function addDays(ymd: string, n: number): string {
  const anchor = ymdToNoonUTC(ymd);
  anchor.setUTCDate(anchor.getUTCDate() + n);
  return kolkataYMD(anchor);
}

/** Inclusive count of calendar days from `start` to `end`. */
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

/** max of two YYYY-MM-DD strings (lexicographic works for this format). */
function maxYMD(a: string, b: string): string {
  return a >= b ? a : b;
}

/* --------------------------------------------------------------- helpers -- */

/**
 * Calculate pause allowance based on subscription tenure.
 * 1mo(30d)=3, 3mo(90d)=20, 6mo(180d)=25, 1yr(360d)+=30.
 */
function calculatePauseAllowance(daysTotal: number): number {
  if (daysTotal <= 30) return 3;
  if (daysTotal <= 90) return 20;
  if (daysTotal <= 180) return 25;
  return 30;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

function isDuplicateKeyError(err: unknown): boolean {
  if (err instanceof MongoServerError && err.code === 11000) return true;
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: number; writeErrors?: Array<{ code?: number }> };
    if (e.code === 11000) return true;
    if (Array.isArray(e.writeErrors) && e.writeErrors.every(w => w.code === 11000)) return true;
  }
  return false;
}

/* ================================================================ PLATFORM ==
 * OWNER: B1 (subscriptions & orders). The four functions below are the contract
 * other agents code against — signatures fixed, bodies implemented here.
 * ========================================================================== */

/**
 * Append `days` delivery days after the subscription's current endDate (source
 * 'plan' for pause shifts, 'makeup' for our-fault compensation) and move endDate.
 *
 * Never onto a locked or past date: the first appended date is
 * max(endDate + 1, firstOpenDateNow(ctx)), then `days` consecutive dates. A day
 * appended onto a locked/past date would go unconfirmed at close, be auto-resolved
 * as our fault and compensated with another appended day — an endless loop of
 * phantom deliveries. Gap dates between the old endDate and the first appended date
 * are simply not deliveries.
 *
 * A queued, not-yet-started renewal (renewedBy, status 'scheduled') is shifted by
 * the number of calendar days endDate actually moved, so the two never overlap.
 */
export async function extendSubscription(
  subscriptionId: ObjectId,
  days: number,
  source: 'plan' | 'makeup',
  ctx: OpCtx,
): Promise<{ newEndDate: string; appended: string[] }> {
  if (!Number.isInteger(days) || days <= 0) throw new Error('extendSubscription: days must be a positive integer');
  const db = await getDb();
  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });
  if (!sub) throw new Error(`extendSubscription: subscription ${subscriptionId.toHexString()} not found`);

  const firstOpen = await firstOpenDateNow(ctx, db);
  const firstDate = maxYMD(addDays(sub.endDate, 1), firstOpen);
  const perDayLitres = sub.qtyNum / sub.qtyDen;
  const appended = dateRange(firstDate, days);
  const rows: Omit<Delivery, '_id'>[] = appended.map(date => ({
    subscriptionId,
    mobile: sub.mobile,
    date,
    kind: sub.kind,
    litres: perDayLitres,
    pincode: sub.pincode,
    status: 'planned',
    source,
    updatedAt: ctx.now,
    ...(sub.stopKey ? { stopKey: sub.stopKey } : {}),
  }));
  const newEndDate = appended[appended.length - 1]!;

  // Shift the renewal BEFORE inserting our rows: its planned rows may sit on the
  // very dates we are about to append.
  const moved = daysInclusive(sub.endDate, newEndDate) - 1;
  await shiftQueuedRenewal(sub, moved, ctx);

  try {
    await col.deliveries(db).insertMany(rows, { ordered: false });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }

  await col.subscriptions(db).updateOne({ _id: subscriptionId }, { $set: { endDate: newEndDate } });

  await recordEvent(ctx, {
    entity: 'subscription',
    entityId: subscriptionId.toHexString(),
    type: 'subscription.extended',
    mobile: sub.mobile,
    data: { days, source, fromEndDate: sub.endDate, newEndDate, appended },
  }, db);

  return { newEndDate, appended };
}

/**
 * Mirror of extendSubscription (used by unpause): remove the latest `days` planned
 * 'plan' rows that are still on/after the first open date and pull endDate back to
 * the last remaining plan/makeup delivery. Refused with DateLockedError when fewer
 * than `days` such rows exist (the tail is already locked/past). A queued renewal is
 * pulled back by the days endDate moved, but never onto a locked date.
 */
export async function shortenSubscription(
  subscriptionId: ObjectId,
  days: number,
  ctx: OpCtx,
): Promise<{ newEndDate: string; removed: string[] }> {
  if (!Number.isInteger(days) || days <= 0) throw new Error('shortenSubscription: days must be a positive integer');
  const db = await getDb();
  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });
  if (!sub) throw new Error(`shortenSubscription: subscription ${subscriptionId.toHexString()} not found`);

  const firstOpen = await firstOpenDateNow(ctx, db);
  const tail = await col
    .deliveries(db)
    .find({ subscriptionId, status: 'planned', source: 'plan', date: { $gte: firstOpen } })
    .sort({ date: -1 })
    .limit(days)
    .toArray();
  if (tail.length < days) throw new DateLockedError(sub.endDate, firstOpen);

  await col.deliveries(db).deleteMany({ _id: { $in: tail.map(r => r._id!) } });
  const removed = tail.map(r => r.date);

  const last = await col
    .deliveries(db)
    .find({ subscriptionId, source: { $in: ['plan', 'makeup'] } })
    .sort({ date: -1 })
    .limit(1)
    .toArray();
  // No remaining row at all: the term is the start date minus one day's worth — keep
  // endDate at the day before the earliest removed date so the arithmetic stays sane.
  const newEndDate = last[0]?.date ?? addDays(removed[removed.length - 1]!, -1);
  await col.subscriptions(db).updateOne({ _id: subscriptionId }, { $set: { endDate: newEndDate } });

  const moved = daysInclusive(newEndDate, sub.endDate) - 1;
  if (moved > 0) await shiftQueuedRenewal(sub, -moved, ctx);

  await recordEvent(ctx, {
    entity: 'subscription',
    entityId: subscriptionId.toHexString(),
    type: 'subscription.shortened',
    mobile: sub.mobile,
    data: { days, fromEndDate: sub.endDate, newEndDate, removed },
  }, db);

  return { newEndDate, removed };
}

/**
 * Move a queued, not-yet-started renewal by `shift` calendar days (negative = earlier).
 * A backward shift is clamped so the renewal never starts before the first open date.
 */
async function shiftQueuedRenewal(sub: Subscription, shift: number, ctx: OpCtx): Promise<void> {
  if (!sub.renewedBy || shift === 0) return;
  const db = await getDb();
  const renewal = await col.subscriptions(db).findOne({ _id: sub.renewedBy });
  if (!renewal?._id || renewal.status !== 'scheduled') return;

  let n = shift;
  if (n < 0) {
    const firstOpen = await firstOpenDateNow(ctx, db);
    const room = daysInclusive(firstOpen, renewal.startDate) - 1; // days it may move back
    n = -Math.min(-n, Math.max(0, room));
    if (n === 0) return;
  }
  // Unique {subscriptionId,date,source}: forward shifts move latest-first, backward
  // shifts earliest-first, so no row ever lands on a date still occupied.
  const rowsToMove = await col
    .deliveries(db)
    .find({ subscriptionId: renewal._id, status: 'planned' })
    .sort({ date: n > 0 ? -1 : 1 })
    .toArray();
  for (const r of rowsToMove) {
    await col.deliveries(db).updateOne({ _id: r._id }, { $set: { date: addDays(r.date, n), updatedAt: ctx.now } });
  }
  const startDate = addDays(renewal.startDate, n);
  const endDate = addDays(renewal.endDate, n);
  await col.subscriptions(db).updateOne({ _id: renewal._id }, { $set: { startDate, endDate } });
  await recordEvent(ctx, {
    entity: 'subscription',
    entityId: renewal._id.toHexString(),
    type: 'subscription.renewal_shifted',
    mobile: renewal.mobile,
    data: { days: n, startDate, endDate },
  }, db);
}

/** Tick step: scheduled → active on startDate. */
export async function activateDueSubscriptions(ctx: OpCtx): Promise<{ activated: number }> {
  const db = await getDb();
  const today = kolkataYMD(ctx.now);
  const due = await col
    .subscriptions(db)
    .find({ status: 'scheduled', startDate: { $lte: today } })
    .toArray();
  let activated = 0;
  for (const sub of due) {
    if (!sub._id) continue;
    try {
      assertTransition('subscription', SUB_TRANSITIONS, 'scheduled', 'active');
    } catch {
      continue;
    }
    const res = await col
      .subscriptions(db)
      .updateOne({ _id: sub._id, status: 'scheduled' }, { $set: { status: 'active' } });
    if (res.matchedCount === 1) {
      activated++;
      await recordEvent(ctx, {
        entity: 'subscription',
        entityId: sub._id.toHexString(),
        type: 'subscription.activated',
        from: 'scheduled',
        to: 'active',
        mobile: sub.mobile,
      }, db);
    }
  }
  return { activated };
}

/** Tick step: active → completed once endDate has passed and nothing is left to deliver. */
export async function completeEndedSubscriptions(ctx: OpCtx): Promise<{ completed: number }> {
  const db = await getDb();
  const today = kolkataYMD(ctx.now);
  const ended = await col
    .subscriptions(db)
    .find({ status: 'active', endDate: { $lt: today } })
    .toArray();
  let completed = 0;
  for (const sub of ended) {
    if (!sub._id) continue;
    // nothing left that could still be delivered (planned/locked/out/unconfirmed)
    const open = await col.deliveries(db).countDocuments(
      {
        subscriptionId: sub._id,
        status: { $in: ['planned', 'locked', 'out_for_delivery', 'unconfirmed'] },
      },
      { limit: 1 },
    );
    if (open > 0) continue;
    try {
      assertTransition('subscription', SUB_TRANSITIONS, 'active', 'completed');
    } catch {
      continue;
    }
    const res = await col
      .subscriptions(db)
      .updateOne({ _id: sub._id, status: 'active' }, { $set: { status: 'completed', completedAt: ctx.now } });
    if (res.matchedCount === 1) {
      completed++;
      await recordEvent(ctx, {
        entity: 'subscription',
        entityId: sub._id.toHexString(),
        type: 'subscription.completed',
        from: 'active',
        to: 'completed',
        mobile: sub.mobile,
      }, db);
    }
  }
  return { completed };
}

/**
 * The customer's current plan chain for a renewal: the subscription a 'renewal'
 * checkout would continue after, and the date the new plan would start.
 *
 * The target must belong to `mobile`, be scheduled|active, and not already have a
 * renewal queued (renewedBy). The new plan starts the day after the target's
 * endDate — or, if that has already passed, the first open date.
 */
export async function renewalTarget(
  mobile: string,
  subscriptionId: ObjectId,
  ctx?: OpCtx,
): Promise<{ subscription: Subscription; renewStartDate: string } | null> {
  const m = normalizeMobile(mobile);
  if (!m) return null;
  const db = await getDb();
  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });
  if (!sub || sub.mobile !== m) return null;
  if (sub.status !== 'scheduled' && sub.status !== 'active') return null;
  if (sub.renewedBy) return null;
  const firstOpen = await firstOpenDateNow(ctx ?? systemCtx(new Date()), db);
  const dayAfterEnd = addDays(sub.endDate, 1);
  const renewStartDate = maxYMD(dayAfterEnd, firstOpen);
  return { subscription: sub, renewStartDate };
}

/* --------------------------------------------------------------- activate -- */

export interface ActivateContext {
  ctx?: OpCtx;
}

/**
 * Turn a PAID order into a live subscription plus one delivery row per term day.
 *
 * `ctx` is optional for backward compatibility with the payments/verify route and
 * the Razorpay webhook, both of which may call it with just the orderId. When
 * omitted it defaults to a system context at real time.
 *
 * Idempotent: a second call for the same order neither creates a second
 * subscription (unique index on orders→subscription via findOneAndUpdate upsert on
 * orderId) nor duplicates deliveries (unique {subscriptionId,date,source} index).
 *
 * Start date: max(order.startDate ?? paidDay, firstOpenDateNow); for a renewal the
 * requested startDate is already the day-after-end from checkout, and we clamp it
 * to first-open the same way. Renewal linking: renewedBy / renewalOf.
 */
export async function activateSubscriptionForOrder(orderId: ObjectId, ctx?: OpCtx): Promise<void> {
  const opCtx = ctx ?? systemCtx(new Date());
  const db = await getDb();
  const order = await col.orders(db).findOne({ _id: orderId });
  if (!order) throw new Error(`activate: order ${orderId.toHexString()} not found`);
  if (order.status !== 'paid') {
    throw new Error(`activate: order ${orderId.toHexString()} is "${order.status}", not paid`);
  }

  const mobile = normalizeMobile(order.mobile);
  if (!mobile) throw new Error(`activate: order has invalid mobile "${order.mobile}"`);

  const daysTotal = order.days;
  const firstOpen = await firstOpenDateNow(opCtx, db);

  // Requested start: the order's startDate if set, else the paid day (Kolkata).
  let requested = order.startDate ?? kolkataYMD(order.paidAt ?? opCtx.now);
  // Renewal chaining: start the day after the renewed plan's CURRENT end — it may
  // have been extended (pause shift / make-up day) between checkout and payment.
  if (order.purpose === 'renewal' && order.renewsSubscriptionId) {
    const renewed = await col.subscriptions(db).findOne({ _id: order.renewsSubscriptionId });
    if (renewed && renewed.mobile === mobile) requested = addDays(renewed.endDate, 1);
  }
  const startDate = maxYMD(requested, firstOpen);
  const endDate = addDays(startDate, daysTotal - 1);
  // Status is 'scheduled' until the start date arrives (tick activates it), else
  // active immediately when the plan starts today.
  const today = kolkataYMD(opCtx.now);
  const status: 'scheduled' | 'active' = startDate <= today ? 'active' : 'scheduled';

  const g = gcd(Math.round(order.litres), order.days);
  const qtyNum = Math.round(order.litres) / g;
  const qtyDen = order.days / g;
  const perDayLitres = order.litres / order.days;

  // Location → stopKey + zone (both cached on the subscription for the router).
  const location = order.location;
  const stopKey = location ? stopKeyOf(mobile, location) : undefined;
  let zoneId: ObjectId | undefined;
  if (location) {
    const zone = await zoneForPoint(location);
    if (zone?._id) zoneId = zone._id;
  }

  const now = opCtx.now;
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
    status,
    pincode: order.pincode,
    ...(order.name ? { name: order.name } : {}),
    ...(order.address ? { address: order.address } : {}),
    ...(order.landmark ? { landmark: order.landmark } : {}),
    ...(order.instructions ? { instructions: order.instructions } : {}),
    ...(order.addressParts ? { addressParts: order.addressParts } : {}),
    ...(location ? { location: { lat: location.lat, lng: location.lng } } : {}),
    ...(stopKey ? { stopKey } : {}),
    ...(zoneId ? { zoneId } : {}),
    createdAt: now,
    ...(status === 'active' ? { activatedAt: now } : {}),
  };

  const res = await col.subscriptions(db).findOneAndUpdate(
    { orderId },
    { $setOnInsert: subDoc },
    { upsert: true, returnDocument: 'after' },
  );
  const sub = res;
  if (!sub?._id) throw new Error(`activate: could not upsert subscription for order ${orderId.toHexString()}`);
  const subscriptionId = sub._id;

  // Renewal linking: this order continues renewsSubscriptionId. Link both sides,
  // guarded so a retry does not clobber an already-set renewedBy.
  if (order.purpose === 'renewal' && order.renewsSubscriptionId) {
    await col.subscriptions(db).updateOne(
      { _id: subscriptionId },
      { $set: { renewalOf: order.renewsSubscriptionId } },
    );
    await col.subscriptions(db).updateOne(
      { _id: order.renewsSubscriptionId, renewedBy: { $exists: false } },
      { $set: { renewedBy: subscriptionId } },
    );
  }

  // One delivery per day, skipping already-paused dates, idempotent on the unique
  // {subscriptionId,date,source} index. New rows are 'planned' with source 'plan'.
  const pausedDates = await col.pausedDates(db).find({ subscriptionId }).toArray();
  const pausedDateSet = new Set(pausedDates.map(p => p.date));
  // Use the STORED start (a retry on a later day must not re-plan other dates).
  const allDates = dateRange(sub.startDate, sub.daysTotal);
  const deliveryDates = allDates.filter(d => !pausedDateSet.has(d));

  const rows: Omit<Delivery, '_id'>[] = deliveryDates.map(date => ({
    subscriptionId,
    mobile,
    date,
    kind: order.kind,
    litres: perDayLitres,
    pincode: order.pincode,
    status: 'planned',
    source: 'plan',
    updatedAt: now,
    ...(stopKey ? { stopKey } : {}),
  }));

  try {
    if (rows.length > 0) await col.deliveries(db).insertMany(rows, { ordered: false });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }

  // The zone's rider gets a route refresh — a new stop appeared. Cheap, never throws.
  if (zoneId) {
    const zone = await col.zones(db).findOne({ _id: zoneId });
    await markRouteDirty(zone?.riderId ?? null, 'new subscription', opCtx);
  }

  await recordEvent(opCtx, {
    entity: 'subscription',
    entityId: subscriptionId.toHexString(),
    type: 'subscription.created',
    to: status,
    mobile,
    data: { orderId: orderId.toHexString(), startDate, endDate, days: daysTotal },
  }, db);
}

/* ----------------------------------------------------------------- cancel -- */

export interface CancelOptions {
  reason?: string;
}

export interface CancelResult {
  status: 'cancelled';
  /** first date with no delivery — the first open date now */
  cancelEffectiveDate: string;
  daysDelivered: number;
  /** future planned rows removed */
  daysRemaining: number;
  refundId: string | null;
}

/**
 * Cancel a subscription per the published policy.
 *
 * Effective from firstOpenDateNow: planned/makeup rows on/after that date are
 * DELETED; locked / out_for_delivery / delivered / unconfirmed rows stay and count
 * as charged. Extras are kept. Future paused_dates are cleared. Status → cancelled
 * with cancelEffectiveDate / cancelledBy / cancelReason. Then createCancellationRefund
 * (B3), and a cancellation_confirmed message is enqueued. Idempotent.
 */
export async function cancelSubscription(id: ObjectId, ctx: OpCtx, opts?: CancelOptions): Promise<CancelResult> {
  const db = await getDb();
  const sub = await col.subscriptions(db).findOne({ _id: id });
  if (!sub) throw new Error(`cancel: subscription ${id.toHexString()} not found`);
  if (sub.status === 'completed') throw new Error('cancel: subscription is already completed');

  if (sub.status === 'cancelled') {
    const existingRefund = await col.refunds(db).findOne({ subscriptionId: id });
    return {
      status: 'cancelled',
      cancelEffectiveDate: sub.cancelEffectiveDate ?? sub.endDate,
      daysDelivered: sub.daysDelivered,
      daysRemaining: 0,
      refundId: existingRefund?._id?.toHexString() ?? sub.refundId?.toHexString() ?? null,
    };
  }

  assertTransition('subscription', SUB_TRANSITIONS, sub.status, 'cancelled');

  const effective = await firstOpenDateNow(ctx, db);

  // Remove future plan/makeup deliveries from the effective date onward. Extras
  // (source 'extra') are paid-for one-offs and are kept. Locked/out/delivered/
  // unconfirmed rows are history and count as charged, so we only touch 'planned'.
  const del = await col.deliveries(db).deleteMany({
    subscriptionId: id,
    status: 'planned',
    source: { $in: ['plan', 'makeup'] },
    date: { $gte: effective },
  });
  const daysRemaining = del.deletedCount ?? 0;

  // Future pause selections no longer mean anything.
  await col.pausedDates(db).deleteMany({ subscriptionId: id, date: { $gte: effective } });

  const res = await col.subscriptions(db).findOneAndUpdate(
    { _id: id, status: sub.status },
    {
      $set: {
        status: 'cancelled',
        cancelledAt: ctx.now,
        cancelEffectiveDate: effective,
        cancelledBy: ctx.actor,
        ...(opts?.reason ? { cancelReason: opts.reason } : {}),
      },
    },
    { returnDocument: 'after' },
  );
  if (!res) {
    // Lost the race — someone else cancelled first. Return the settled shape.
    const now = await col.subscriptions(db).findOne({ _id: id });
    const existingRefund = await col.refunds(db).findOne({ subscriptionId: id });
    return {
      status: 'cancelled',
      cancelEffectiveDate: now?.cancelEffectiveDate ?? effective,
      daysDelivered: now?.daysDelivered ?? sub.daysDelivered,
      daysRemaining,
      refundId: existingRefund?._id?.toHexString() ?? null,
    };
  }

  await recordEvent(ctx, {
    entity: 'subscription',
    entityId: id.toHexString(),
    type: 'subscription.cancelled',
    from: sub.status,
    to: 'cancelled',
    mobile: sub.mobile,
    ...(opts?.reason ? { reason: opts.reason } : {}),
    data: { cancelEffectiveDate: effective, daysRemaining },
  }, db);

  // Refund per policy (B3). Idempotent per subscription; may be null when nothing owed.
  let refund: Awaited<ReturnType<typeof createCancellationRefund>> = null;
  try {
    refund = await createCancellationRefund(id, ctx);
  } catch (err) {
    // B3's stub throws 'not implemented' until built — do not fail the cancellation
    // that already happened. Log and carry on; the refund is reconcilable later.
    // eslint-disable-next-line no-console
    console.error('[cancel] createCancellationRefund failed', id.toHexString(), err instanceof Error ? err.message : err);
  }

  if (refund?._id) {
    await col.subscriptions(db).updateOne({ _id: id }, { $set: { refundId: refund._id } });
  }

  // cancellation_confirmed (never throws).
  await enqueueMessage(
    {
      mobile: sub.mobile,
      template: 'cancellation_confirmed',
      params: {
        lastDate: addDays(effective, -1),
        refund: refund ? formatINR(refund.amountPaise) : formatINR(0),
      },
      dedupeKey: `cancel:${id.toHexString()}`,
    },
    ctx,
  );

  return {
    status: 'cancelled',
    cancelEffectiveDate: effective,
    daysDelivered: res.daysDelivered,
    daysRemaining,
    refundId: refund?._id?.toHexString() ?? null,
  };
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
 * The next `days` of upcoming deliveries for a customer's mobile — planned and
 * locked rows (the ones still to happen), oldest date first.
 */
export async function upcomingDeliveries(mobile: string, days: number, ctx?: OpCtx): Promise<UpcomingDelivery[]> {
  const m = normalizeMobile(mobile);
  if (!m) throw new Error(`upcoming: invalid mobile "${mobile}"`);
  if (!Number.isInteger(days) || days <= 0) throw new Error('upcoming: days must be a positive integer');

  const db = await getDb();
  const from = kolkataYMD(ctx?.now ?? new Date());
  const to = addDays(from, days - 1);

  const rows = await col
    .deliveries(db)
    .find({ mobile: m, status: { $in: ['planned', 'locked'] }, date: { $gte: from, $lte: to } })
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
