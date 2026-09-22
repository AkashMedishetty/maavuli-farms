import type { ObjectId } from 'mongodb';
import { getDb } from './db';
import { col, type Delivery, type PausedDate, type Subscription } from './models';
import { addDays, kolkataYMD, todayKolkata } from './subscriptions';

/**
 * Calendar-based subscription pause management.
 *
 * Customers can pause individual delivery dates (not continuous ranges) up to
 * their subscription's pause allowance. Each paused date:
 *  · Consumes 1 pause day from the allowance
 *  · Extends the subscription end date by 1 day
 *  · Is NOT delivered and NOT charged
 *  · Can only be selected before 4 PM for next-day delivery
 *
 * ASSUMPTION: pause days belong to the subscription, NOT the calendar month.
 * A 3-month subscription has 20 pause days across its entire term, usable
 * flexibly (e.g., every weekend, or one full week).
 */

/* --------------------------------------------------------- cutoff check -- */

/**
 * Returns the earliest date the customer can pause RIGHT NOW, respecting the
 * 4 PM cutoff. Before 4 PM today: tomorrow. After 4 PM: day after tomorrow.
 */
export function earliestPausableDate(): string {
  const now = new Date();
  // Convert current time to Asia/Kolkata hour to check 4 PM cutoff
  const kolkataHour = new Date(
    now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
  ).getHours();

  const today = todayKolkata();

  // Before 4 PM: can pause tomorrow onwards
  // After 4 PM: can only pause day after tomorrow onwards
  const daysOffset = kolkataHour < 16 ? 1 : 2;
  return addDays(today, daysOffset);
}

/**
 * Check if a date is pausable right now (respects cutoff and subscription range).
 */
export function isDatePausable(date: string, sub: Subscription): {
  pausable: boolean;
  reason?: string;
} {
  const earliest = earliestPausableDate();

  if (date < earliest) {
    return {
      pausable: false,
      reason: `Cannot pause dates before ${earliest} due to 4 PM cutoff`,
    };
  }

  if (date < sub.startDate) {
    return { pausable: false, reason: 'Date is before subscription start' };
  }

  if (date > sub.endDate) {
    return { pausable: false, reason: 'Date is after subscription end' };
  }

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

/**
 * Pause individual delivery dates. Each date consumes 1 pause day and extends
 * the subscription by 1 day. Idempotent: already-paused dates are no-ops.
 */
export async function pauseDates(
  subscriptionId: ObjectId,
  dates: string[]
): Promise<PauseDateResult> {
  const db = await getDb();

  // Validate subscription exists and is active
  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });
  if (!sub) {
    return { success: false, message: 'Subscription not found' };
  }

  if (sub.status === 'completed' || sub.status === 'cancelled') {
    return {
      success: false,
      message: `Cannot pause dates: subscription is ${sub.status}`,
    };
  }

  // Check each date is pausable
  for (const date of dates) {
    const check = isDatePausable(date, sub);
    if (!check.pausable) {
      return { success: false, message: check.reason! };
    }
  }

  // Check if we have enough pause days remaining
  const remaining = sub.pauseAllowanceDays - sub.pauseUsedDays;
  if (dates.length > remaining) {
    return {
      success: false,
      message: `Not enough pause days. You have ${remaining} days remaining, but requested ${dates.length}.`,
      pauseUsedDays: sub.pauseUsedDays,
      pauseAllowanceDays: sub.pauseAllowanceDays,
    };
  }

  // Check which dates are already paused (idempotency)
  const alreadyPaused = await col
    .pausedDates(db)
    .find({ subscriptionId, date: { $in: dates } })
    .toArray();
  const alreadyPausedDates = new Set(alreadyPaused.map(p => p.date));
  const newDates = dates.filter(d => !alreadyPausedDates.has(d));

  if (newDates.length === 0) {
    return {
      success: true,
      message: 'All dates were already paused',
      pauseUsedDays: sub.pauseUsedDays,
      pauseAllowanceDays: sub.pauseAllowanceDays,
      newEndDate: sub.endDate,
    };
  }

  const now = new Date();

  // Insert new paused dates
  const pausedDocs: Omit<PausedDate, '_id'>[] = newDates.map(date => ({
    subscriptionId,
    mobile: sub.mobile,
    date,
    pausedAt: now,
  }));

  try {
    await col.pausedDates(db).insertMany(pausedDocs, { ordered: false });
  } catch (err: any) {
    // Ignore duplicate key errors (concurrent pause attempts)
    if (err.code !== 11000) throw err;
  }

  // Sync the delivery rows to the pause. A paused date must not be delivered, so
  // its scheduled row is removed; and because the customer keeps every day they
  // paid for, one make-up day is appended to the end for each paused date. Net: the
  // same number of deliveries, shifted later. Only `scheduled` rows are touched — a
  // delivered day cannot be paused, and the 4 PM cutoff guarantees paused dates are
  // always in the future, so their row is still scheduled.
  await col.deliveries(db).deleteMany({
    subscriptionId,
    date: { $in: newDates },
    status: 'scheduled',
  });

  const extensionDays = newDates.length;
  const newEndDate = addDays(sub.endDate, extensionDays);

  // The appended make-up days: one scheduled delivery for each day past the old end.
  const perDayLitres = sub.qtyNum / sub.qtyDen;
  const makeUpRows: Omit<Delivery, '_id'>[] = [];
  for (let i = 1; i <= extensionDays; i++) {
    makeUpRows.push({
      subscriptionId,
      mobile: sub.mobile,
      date: addDays(sub.endDate, i),
      kind: sub.kind,
      litres: perDayLitres,
      pincode: sub.pincode,
      status: 'scheduled',
      updatedAt: now,
    });
  }
  if (makeUpRows.length > 0) {
    try {
      await col.deliveries(db).insertMany(makeUpRows, { ordered: false });
    } catch (err: any) {
      if (err.code !== 11000) throw err;
    }
  }

  await col.subscriptions(db).updateOne(
    { _id: subscriptionId },
    {
      $set: { endDate: newEndDate },
      $inc: { pauseUsedDays: extensionDays },
    }
  );

  return {
    success: true,
    message: `Successfully paused ${extensionDays} date(s). Subscription extended to ${newEndDate}.`,
    pauseUsedDays: sub.pauseUsedDays + extensionDays,
    pauseAllowanceDays: sub.pauseAllowanceDays,
    newEndDate,
  };
}

/* -------------------------------------------------------- unpause dates -- */

/**
 * Unpause (re-enable) previously paused dates. Only allowed if the date hasn't
 * passed yet and respects the 4 PM cutoff.
 */
export async function unpauseDates(
  subscriptionId: ObjectId,
  dates: string[]
): Promise<PauseDateResult> {
  const db = await getDb();

  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });
  if (!sub) {
    return { success: false, message: 'Subscription not found' };
  }

  if (sub.status === 'completed' || sub.status === 'cancelled') {
    return {
      success: false,
      message: `Cannot unpause dates: subscription is ${sub.status}`,
    };
  }

  // Check cutoff for each date
  const earliest = earliestPausableDate();
  for (const date of dates) {
    if (date < earliest) {
      return {
        success: false,
        message: `Cannot unpause ${date}: it's past the 4 PM cutoff`,
      };
    }
  }

  // Find which dates are actually paused
  const paused = await col
    .pausedDates(db)
    .find({ subscriptionId, date: { $in: dates } })
    .toArray();

  if (paused.length === 0) {
    return {
      success: true,
      message: 'No dates were paused',
      pauseUsedDays: sub.pauseUsedDays,
      pauseAllowanceDays: sub.pauseAllowanceDays,
      newEndDate: sub.endDate,
    };
  }

  const restoredDates = paused.map(p => p.date);

  // Delete paused date records
  await col.pausedDates(db).deleteMany({
    subscriptionId,
    date: { $in: restoredDates },
  });

  // Shorten subscription end date and decrement pause usage
  const restoredDays = restoredDates.length;
  const newEndDate = addDays(sub.endDate, -restoredDays);

  // Mirror image of pauseDates: give the restored dates their scheduled delivery
  // back, and drop the make-up days that were appended past the now-shorter end.
  const now = new Date();
  const perDayLitres = sub.qtyNum / sub.qtyDen;
  const restoreRows: Omit<Delivery, '_id'>[] = restoredDates
    .filter(d => d <= newEndDate) // a restored make-up day is dropped by the tail delete below, not re-created
    .map(date => ({
      subscriptionId,
      mobile: sub.mobile,
      date,
      kind: sub.kind,
      litres: perDayLitres,
      pincode: sub.pincode,
      status: 'scheduled' as const,
      updatedAt: now,
    }));
  if (restoreRows.length > 0) {
    try {
      await col.deliveries(db).insertMany(restoreRows, { ordered: false });
    } catch (err: any) {
      if (err.code !== 11000) throw err; // the day already has a row — fine
    }
  }
  // Everything still scheduled past the new end is an appended make-up day; remove it.
  await col.deliveries(db).deleteMany({
    subscriptionId,
    status: 'scheduled',
    date: { $gt: newEndDate },
  });

  await col.subscriptions(db).updateOne(
    { _id: subscriptionId },
    {
      $set: { endDate: newEndDate },
      $inc: { pauseUsedDays: -restoredDays },
    }
  );

  return {
    success: true,
    message: `Successfully unpaused ${restoredDays} date(s). Subscription shortened to ${newEndDate}.`,
    pauseUsedDays: sub.pauseUsedDays - restoredDays,
    pauseAllowanceDays: sub.pauseAllowanceDays,
    newEndDate,
  };
}

/* ------------------------------------------------------- get paused dates -- */

export interface PausedDateInfo {
  date: string;
  pausedAt: string; // ISO timestamp
}

/**
 * Get all paused dates for a subscription, sorted chronologically.
 */
export async function getPausedDates(
  subscriptionId: ObjectId
): Promise<PausedDateInfo[]> {
  const db = await getDb();
  const paused = await col
    .pausedDates(db)
    .find({ subscriptionId })
    .sort({ date: 1 })
    .toArray();

  return paused.map(p => ({
    date: p.date,
    pausedAt: p.pausedAt.toISOString(),
  }));
}

/* ------------------------------------------------- subscription calendar -- */

export interface SubscriptionCalendar {
  subscriptionId: string;
  startDate: string;
  endDate: string;
  pauseAllowanceDays: number;
  pauseUsedDays: number;
  pauseRemainingDays: number;
  earliestPausableDate: string;
  pausedDates: string[];
}

/**
 * Get complete calendar information for a subscription including pause balance
 * and all paused dates.
 */
export async function getSubscriptionCalendar(
  subscriptionId: ObjectId
): Promise<SubscriptionCalendar | null> {
  const db = await getDb();
  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });

  if (!sub) return null;

  const paused = await getPausedDates(subscriptionId);

  return {
    subscriptionId: subscriptionId.toHexString(),
    startDate: sub.startDate,
    endDate: sub.endDate,
    pauseAllowanceDays: sub.pauseAllowanceDays,
    pauseUsedDays: sub.pauseUsedDays,
    pauseRemainingDays: sub.pauseAllowanceDays - sub.pauseUsedDays,
    earliestPausableDate: earliestPausableDate(),
    pausedDates: paused.map(p => p.date),
  };
}
