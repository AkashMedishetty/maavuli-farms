// scripts/roll-deliveries.mjs
//
// Daily maintenance job, run once per morning AFTER the round:
//   1. mark yesterday's still-`scheduled` deliveries as `delivered`
//   2. complete any subscription whose endDate has passed
//
// Plain node ESM — no TypeScript, no build step, runnable from cron. It cannot
// import lib/subscriptions.ts (that is TS), so the two Kolkata date helpers are
// re-derived here from the SAME rule: format through Intl with
// timeZone 'Asia/Kolkata', never a date library, never a hand-rolled +5:30.
//
// Idempotent: re-running it the same day changes nothing new. Marking is scoped
// to status:'scheduled', so a delivery already delivered/skipped is untouched, and
// completing a subscription is a status flip that a second run re-applies to the
// same value.
//
// Run:  node scripts/roll-deliveries.mjs           (does the work; needs a DB)
//       node scripts/roll-deliveries.mjs --check    (runs the date assertions only)

import process from 'node:process';

/* ----------------------------------------------------------- date helpers -- */

const KOLKATA_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Any instant -> the YYYY-MM-DD calendar date it falls on in Asia/Kolkata. */
export function kolkataYMD(d) {
  return KOLKATA_FMT.format(d);
}

export function todayKolkata() {
  return kolkataYMD(new Date());
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD -> a UTC-noon Date. Noon keeps the anchor 12h from any day edge. */
function ymdToNoonUTC(ymd) {
  if (!YMD_RE.test(ymd)) throw new Error(`not a YYYY-MM-DD date: "${ymd}"`);
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  if (kolkataYMD(date) !== ymd) throw new Error(`not a real calendar date: "${ymd}"`);
  return date;
}

/** Add n whole days to a YYYY-MM-DD, returning a YYYY-MM-DD. */
export function addDays(ymd, n) {
  const anchor = ymdToNoonUTC(ymd);
  anchor.setUTCDate(anchor.getUTCDate() + n);
  return kolkataYMD(anchor);
}

/** Inclusive day count: 1st..1st = 1, 1st..3rd = 3. */
export function daysInclusive(start, end) {
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((ymdToNoonUTC(end) - ymdToNoonUTC(start)) / MS) + 1;
}

/* --------------------------------------------------------------- self-test -- */
//
// These prove the date math survives month AND year boundaries — the exact place
// a UTC-offset hack silently loses a day. A 30-day term is [start .. start+29].

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`ASSERT FAILED: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

export function runDateAssertions() {
  // --- crosses a MONTH boundary (Jan 20 -> Feb, 30-day term) ---------------
  assertEq(addDays('2025-01-20', 29), '2025-02-18', '30-day term from 2025-01-20 ends 2025-02-18');
  assertEq(daysInclusive('2025-01-20', '2025-02-18'), 30, '30 inclusive days across Jan->Feb');

  // --- crosses a YEAR boundary (Dec 20 2025 -> Jan 2026, 30-day term) ------
  assertEq(addDays('2025-12-20', 29), '2026-01-18', '30-day term from 2025-12-20 ends 2026-01-18');
  assertEq(daysInclusive('2025-12-20', '2026-01-18'), 30, '30 inclusive days across year boundary');

  // --- LEAP February is counted correctly (2024 is a leap year) -----------
  //     Feb 15 + 15 days lands on Mar 1 because Feb 2024 has 29 days.
  assertEq(addDays('2024-02-15', 15), '2024-03-01', 'leap Feb: 2024-02-15 + 15 = 2024-03-01');
  assertEq(daysInclusive('2024-02-01', '2024-02-29'), 29, 'leap Feb has 29 days');
  //     Non-leap 2025 February has 28.
  assertEq(daysInclusive('2025-02-01', '2025-02-28'), 28, 'non-leap Feb has 28 days');

  // --- a full 360-day (1yr) term across a year boundary -------------------
  assertEq(addDays('2025-06-01', 359), '2026-05-26', '360-day term from 2025-06-01 ends 2026-05-26');
  assertEq(daysInclusive('2025-06-01', '2026-05-26'), 360, '360 inclusive days for the 1yr tenure');

  // --- round-trip: addDays then daysInclusive agree for every tenure ------
  for (const days of [30, 90, 180, 360]) {
    const start = '2025-11-15'; // deliberately near a year boundary
    const end = addDays(start, days - 1);
    assertEq(daysInclusive(start, end), days, `round-trip ${days}-day term from ${start}`);
  }

  // --- the noon anchor is immune to the IST offset ------------------------
  //     23:30 UTC on 2025-03-09 is 05:00 IST on 2025-03-10 — the Kolkata date is
  //     the 10th, not the 9th. This is the exact failure a UTC .getUTCDate() hits.
  assertEq(kolkataYMD(new Date('2025-03-09T23:30:00Z')), '2025-03-10', '23:30Z maps to next Kolkata day');
  assertEq(kolkataYMD(new Date('2025-03-09T18:29:00Z')), '2025-03-09', '18:29Z still same Kolkata day');

  return true;
}

/* -------------------------------------------------------------------- roll -- */

async function roll() {
  // Import the shared DB layer only when actually doing work, so --check needs no
  // database and no env. These are TS modules; node cannot import them without a
  // loader, so this path requires being run through the app's node/tsx runtime OR
  // a compiled build. In this repo there is no reachable database in the sandbox,
  // so --check is the only path exercised here (see report).
  let getDb;
  let col;
  try {
    ({ getDb } = await import('../lib/db.ts'));
    ({ col } = await import('../lib/models.ts'));
  } catch (err) {
    console.error('roll-deliveries: cannot load DB layer (needs a TS-capable runtime and a reachable database).');
    console.error(String(err?.message ?? err));
    process.exitCode = 1;
    return;
  }

  const db = await getDb();
  const today = todayKolkata();
  const yesterday = addDays(today, -1);

  // 1. Yesterday's scheduled deliveries were the round that just ran -> delivered.
  const marked = await col.deliveries(db).updateMany(
    { date: yesterday, status: 'scheduled' },
    { $set: { status: 'delivered', updatedAt: new Date() } },
  );

  // Keep daysDelivered honest: recompute per subscription from the delivered rows
  // rather than a blind $inc (a re-run must not double-count).
  const affected = await col.deliveries(db)
    .aggregate([
      { $match: { status: 'delivered' } },
      { $group: { _id: '$subscriptionId', delivered: { $sum: 1 } } },
    ])
    .toArray();
  for (const row of affected) {
    await col.subscriptions(db).updateOne(
      { _id: row._id },
      { $set: { daysDelivered: row.delivered } },
    );
  }

  // 2. Complete any active/paused subscription whose extended endDate has passed.
  const completed = await col.subscriptions(db).updateMany(
    { status: { $in: ['active', 'paused'] }, endDate: { $lt: today } },
    { $set: { status: 'completed' } },
  );

  console.log(JSON.stringify({
    date: today,
    yesterday,
    deliveriesMarkedDelivered: marked.modifiedCount ?? 0,
    subscriptionsCompleted: completed.modifiedCount ?? 0,
  }));
}

/* -------------------------------------------------------------------- main -- */

const isCheck = process.argv.includes('--check');

// Always run the date assertions — a roll that miscounts days is a silent
// data-loss bug, so we refuse to touch the database if the math is wrong.
try {
  runDateAssertions();
  if (isCheck) {
    console.log('roll-deliveries: all date assertions passed (month, year, leap, 360-day, IST-offset).');
    process.exit(0);
  }
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(1);
}

roll().catch(err => {
  console.error(String(err?.stack ?? err));
  process.exitCode = 1;
});
