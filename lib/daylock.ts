/**
 * Is a delivery date still open for customer changes?
 *
 * Two things close a date, and BOTH are checked:
 *  1. time — it is past the cutoff (cutoffTime on the day before), and
 *  2. materialisation — the lock job has frozen that day's manifest (day_locks).
 *
 * (2) matters because the cutoff is editable: if ops move it later AFTER a day was
 * frozen and handed to riders, time alone would re-open a day whose stops are
 * already on a rider's phone. A materialised lock is never undone by a setting.
 *
 * Every customer-side write — pause, unpause, cancel-from, extra milk, a plan's
 * first delivery, address change — goes through assertDateOpen / firstOpenDateNow.
 */

import type { Db } from 'mongodb';
import { getDb } from './db';
import { col } from './models';
import { addDaysYMD, firstOpenDate, isPastCutoff } from './cutoff';
import { dayRulesOf, getOpsSettings } from './settings';
import { DateLockedError } from './errors';
import type { OpCtx } from './clock';

export async function isDateLocked(date: string, ctx: OpCtx, db?: Db): Promise<boolean> {
  const d = db ?? (await getDb());
  const rules = dayRulesOf(await getOpsSettings(d));
  if (isPastCutoff(date, ctx.now, rules)) return true;
  return (await col.dayLocks(d).countDocuments({ _id: date }, { limit: 1 })) > 0;
}

/** The earliest date a customer can change right now (time AND materialised locks). */
export async function firstOpenDateNow(ctx: OpCtx, db?: Db): Promise<string> {
  const d = db ?? (await getDb());
  const rules = dayRulesOf(await getOpsSettings(d));
  let date = firstOpenDate(ctx.now, rules);
  // a materialised lock can only exist ahead of the time rule if the cutoff moved;
  // bounded scan, a week is far more than enough
  for (let i = 0; i < 7; i++) {
    const locked = (await col.dayLocks(d).countDocuments({ _id: date }, { limit: 1 })) > 0;
    if (!locked) return date;
    date = addDaysYMD(date, 1);
  }
  return date;
}

/** Throws DateLockedError (→ 409, carries the first open date) when `date` is closed. */
export async function assertDateOpen(date: string, ctx: OpCtx, db?: Db): Promise<void> {
  const d = db ?? (await getDb());
  if (await isDateLocked(date, ctx, d)) {
    throw new DateLockedError(date, await firstOpenDateNow(ctx, d));
  }
}
