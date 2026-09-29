import type { ObjectId } from 'mongodb';
import { getDb } from './db';
import { col, type Delivery, type PausedDate, type Subscription } from './models';
import { addDays, extendSubscription, shortenSubscription } from './subscriptions';
import { assertDateOpen, firstOpenDateNow } from './daylock';
import { isYMD } from './cutoff';
import { ConflictError, ValidationError } from './errors';
import { recordEvent } from './events';
import { enqueueMessage } from './notify';
import type { OpCtx } from './clock';

/**
 * Calendar-based subscription pause management.
 *
 * Customers pause individual delivery dates up to their plan's allowance. Each
 * paused date: consumes 1 allowance day, is not delivered, and gets one delivery
 * appended through extendSubscription (never onto a locked/past date). Unpause is
 * the mirror: the date gets its delivery back and the latest open planned 'plan'
 * day is removed through shortenSubscription.
 *
 * The cutoff comes from ops settings via lib/daylock (time AND materialised locks),
 * not a hard-coded 4 PM.
 */

/* --------------------------------------------------------- cutoff check -- */

/** The earliest date the customer can pause or unpause right now. */
export async function earliestPausableDate(ctx: OpCtx): Promise<string> {
  return firstOpenDateNow(ctx);
}

/** Is `date` pausable now for `sub` (open, inside the term)? */
export async function isDatePausable(
  date: string,
  sub: Subscription,
  ctx: OpCtx,
): Promise<{ pausable: boolean; reason?: string }> {
  const earliest = await earliestPausableDate(ctx);
  if (date < earliest) return { pausable: false, reason: `Changes for ${date} have closed. The earliest date you can change is ${earliest}.` };
  if (date < sub.startDate) return { pausable: false, reason: 'Date is before the plan starts' };
  if (date > sub.endDate) return { pausable: false, reason: 'Date is after the plan ends' };
  return { pausable: true };
}

/* ---------------------------------------------------------- pause dates -- */

export interface PauseDateResult {
  success: boolean;
  message: string;
  pauseUsedDays?: number;
  pauseAllowanceDays?: number;
  newEndDate?: string;
}

function validateDates(dates: unknown): string[] {
  if (!Array.isArray(dates) || dates.length === 0) throw new ValidationError('dates must be a non-empty array');
  if (dates.length > 60) throw new ValidationError('At most 60 dates at a time');
  const bad = dates.filter(d => typeof d !== 'string' || !isYMD(d));
  if (bad.length) throw new ValidationError('Dates must be YYYY-MM-DD', bad.map(d => `invalid date: ${String(d)}`));
  return [...new Set(dates as string[])].sort();
}

async function loadLive(subscriptionId: ObjectId): Promise<Subscription> {
  const db = await getDb();
  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });
  if (!sub) throw new ValidationError('Subscription not found');
  if (sub.status !== 'scheduled' && sub.status !== 'active' && sub.status !== 'paused') {
    throw new ConflictError(`This plan is ${sub.status}; its calendar can no longer change.`);
  }
  return sub;
}

/**
 * Pause individual delivery dates. Idempotent: already-paused dates are no-ops.
 * Throws DateLockedError (409) for a closed date, ValidationError for a date outside
 * the term or without a delivery, ConflictError when the allowance is exhausted.
 */
export async function pauseDates(subscriptionId: ObjectId, rawDates: string[], ctx: OpCtx): Promise<PauseDateResult> {
  const dates = validateDates(rawDates);
  const db = await getDb();
  const sub = await loadLive(subscriptionId);

  for (const date of dates) await assertDateOpen(date, ctx, db);
  const outside = dates.filter(d => d < sub.startDate || d > sub.endDate);
  if (outside.length) throw new ValidationError('Some dates are outside this plan', outside.map(d => `${d} is not in ${sub.startDate}..${sub.endDate}`));

  const already = new Set(
    (await col.pausedDates(db).find({ subscriptionId, date: { $in: dates } }).toArray()).map(p => p.date),
  );
  const newDates = dates.filter(d => !already.has(d));
  if (newDates.length === 0) {
    return {
      success: true,
      message: 'All dates were already paused',
      pauseUsedDays: sub.pauseUsedDays,
      pauseAllowanceDays: sub.pauseAllowanceDays,
      newEndDate: sub.endDate,
    };
  }

  // Each date must actually be a planned plan delivery (not a gap day, not an extra-only day).
  const rows = await col
    .deliveries(db)
    .find({ subscriptionId, date: { $in: newDates }, source: 'plan', status: 'planned' })
    .toArray();
  const withRow = new Set(rows.map(r => r.date));
  const noRow = newDates.filter(d => !withRow.has(d));
  if (noRow.length) throw new ValidationError('No delivery is planned on some dates', noRow.map(d => `no delivery on ${d}`));

  const remaining = sub.pauseAllowanceDays - sub.pauseUsedDays;
  if (newDates.length > remaining) {
    throw new ConflictError(`Not enough pause days. You have ${remaining} left, but chose ${newDates.length}.`, {
      pauseUsedDays: sub.pauseUsedDays,
      pauseAllowanceDays: sub.pauseAllowanceDays,
    });
  }

  // Claim the allowance atomically first so two concurrent pauses cannot overspend it.
  const claim = await col.subscriptions(db).updateOne(
    { _id: subscriptionId, pauseUsedDays: { $lte: sub.pauseAllowanceDays - newDates.length } },
    { $inc: { pauseUsedDays: newDates.length, daysPaused: newDates.length } },
  );
  if (claim.matchedCount === 0) throw new ConflictError('Not enough pause days left.');

  const pausedDocs: Omit<PausedDate, '_id'>[] = newDates.map(date => ({
    subscriptionId,
    mobile: sub.mobile,
    date,
    pausedAt: ctx.now,
  }));
  try {
    await col.pausedDates(db).insertMany(pausedDocs, { ordered: false });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  await col.deliveries(db).deleteMany({ subscriptionId, date: { $in: newDates }, source: 'plan', status: 'planned' });

  const { newEndDate } = await extendSubscription(subscriptionId, newDates.length, 'plan', ctx);

  await recordEvent(ctx, {
    entity: 'subscription',
    entityId: subscriptionId.toHexString(),
    type: 'subscription.paused_dates',
    mobile: sub.mobile,
    data: { dates: newDates, newEndDate },
  }, db);

  await enqueueMessage(
    {
      mobile: sub.mobile,
      template: 'pause_confirmed',
      params: { dates: newDates.join(', '), endDate: newEndDate },
      dedupeKey: `pause:${subscriptionId.toHexString()}:${newDates[0]}:${newDates.length}`,
    },
    ctx,
  );

  return {
    success: true,
    message: `Paused ${newDates.length} date(s). Your plan now ends ${newEndDate}.`,
    pauseUsedDays: sub.pauseUsedDays + newDates.length,
    pauseAllowanceDays: sub.pauseAllowanceDays,
    newEndDate,
  };
}

/* -------------------------------------------------------- unpause dates -- */

/**
 * Unpause previously paused dates (mirror of pauseDates). Each restored date gets
 * its planned delivery back and the latest open planned day is removed. Refused
 * with DateLockedError when the restored date is closed, or when no open tail day
 * is left to remove.
 */
export async function unpauseDates(subscriptionId: ObjectId, rawDates: string[], ctx: OpCtx): Promise<PauseDateResult> {
  const dates = validateDates(rawDates);
  const db = await getDb();
  const sub = await loadLive(subscriptionId);

  for (const date of dates) await assertDateOpen(date, ctx, db);

  const paused = await col.pausedDates(db).find({ subscriptionId, date: { $in: dates } }).toArray();
  if (paused.length === 0) {
    return {
      success: true,
      message: 'No dates were paused',
      pauseUsedDays: sub.pauseUsedDays,
      pauseAllowanceDays: sub.pauseAllowanceDays,
      newEndDate: sub.endDate,
    };
  }
  const restored = paused.map(p => p.date).sort();

  // Give the restored dates their delivery back FIRST, so shortenSubscription removes
  // the appended tail day(s) rather than one of these.
  const perDayLitres = sub.qtyNum / sub.qtyDen;
  const restoreRows: Omit<Delivery, '_id'>[] = restored.map(date => ({
    subscriptionId,
    mobile: sub.mobile,
    date,
    kind: sub.kind,
    litres: perDayLitres,
    pincode: sub.pincode,
    status: 'planned',
    source: 'plan',
    updatedAt: ctx.now,
    ...(sub.stopKey ? { stopKey: sub.stopKey } : {}),
  }));
  const inserted: ObjectId[] = [];
  for (const row of restoreRows) {
    try {
      const r = await col.deliveries(db).insertOne(row);
      inserted.push(r.insertedId);
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  let newEndDate: string;
  try {
    ({ newEndDate } = await shortenSubscription(subscriptionId, restored.length, ctx));
  } catch (err) {
    // No open tail day to give back: undo the restore, leave the pause standing.
    if (inserted.length) await col.deliveries(db).deleteMany({ _id: { $in: inserted } });
    throw err;
  }

  await col.pausedDates(db).deleteMany({ subscriptionId, date: { $in: restored } });
  await col.subscriptions(db).updateOne(
    { _id: subscriptionId },
    { $inc: { pauseUsedDays: -restored.length, daysPaused: -restored.length } },
  );

  await recordEvent(ctx, {
    entity: 'subscription',
    entityId: subscriptionId.toHexString(),
    type: 'subscription.unpaused_dates',
    mobile: sub.mobile,
    data: { dates: restored, newEndDate },
  }, db);

  return {
    success: true,
    message: `Restored ${restored.length} date(s). Your plan now ends ${newEndDate}.`,
    pauseUsedDays: sub.pauseUsedDays - restored.length,
    pauseAllowanceDays: sub.pauseAllowanceDays,
    newEndDate,
  };
}

/* ------------------------------------------------------- get paused dates -- */

export interface PausedDateInfo {
  date: string;
  pausedAt: string;
}

export async function getPausedDates(subscriptionId: ObjectId): Promise<PausedDateInfo[]> {
  const db = await getDb();
  const paused = await col.pausedDates(db).find({ subscriptionId }).sort({ date: 1 }).toArray();
  return paused.map(p => ({ date: p.date, pausedAt: p.pausedAt.toISOString() }));
}

/* ------------------------------------------------- subscription calendar -- */

export interface SubscriptionCalendar {
  subscriptionId: string;
  status: Subscription['status'];
  startDate: string;
  endDate: string;
  pauseAllowanceDays: number;
  pauseUsedDays: number;
  pauseRemainingDays: number;
  earliestPausableDate: string;
  pausedDates: string[];
  /** dates with a plan/makeup delivery, and its status */
  deliveries: { date: string; status: Delivery['status']; source: NonNullable<Delivery['source']> }[];
}

export async function getSubscriptionCalendar(subscriptionId: ObjectId, ctx: OpCtx): Promise<SubscriptionCalendar | null> {
  const db = await getDb();
  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });
  if (!sub) return null;
  const paused = await getPausedDates(subscriptionId);
  const rows = await col
    .deliveries(db)
    .find({ subscriptionId }, { projection: { date: 1, status: 1, source: 1 } })
    .sort({ date: 1 })
    .toArray();
  return {
    subscriptionId: subscriptionId.toHexString(),
    status: sub.status,
    startDate: sub.startDate,
    endDate: sub.endDate,
    pauseAllowanceDays: sub.pauseAllowanceDays,
    pauseUsedDays: sub.pauseUsedDays,
    pauseRemainingDays: sub.pauseAllowanceDays - sub.pauseUsedDays,
    earliestPausableDate: await earliestPausableDate(ctx),
    pausedDates: paused.map(p => p.date),
    deliveries: rows.map(r => ({ date: r.date, status: r.status, source: r.source ?? 'plan' })),
  };
}

/** Re-exported for callers that stepped days through this module. */
export { addDays };
