/**
 * Cutoff and day-window arithmetic — PURE, no database, no clock.
 *
 * A milk round is a local-calendar concept, so every rule here is phrased in
 * Asia/Kolkata wall time: "changes for Thursday close at 4 PM on Wednesday",
 * "unmarked deliveries become unconfirmed at 10 AM on the day".
 *
 * Asia/Kolkata has had a fixed +05:30 offset with no daylight saving since 1945,
 * so wall time <-> instant is exact arithmetic here — no Intl, no date library, and
 * therefore identical in the browser, in Node and in these unit tests.
 *
 * Callers pass `now` in; nothing here reads the clock. Business "now" comes from
 * lib/clock (which honours the e2e time-travel header outside production).
 *
 * Import this file with a RELATIVE path ending in .ts from tests
 * (scripts/verify-cutoff.ts runs it under plain node).
 */

export const IST_OFFSET_MIN = 330;
const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The subset of OpsSettings this module needs. */
export interface DayRules {
  /** HH:MM on the day BEFORE a delivery date, after which that date is frozen */
  cutoffTime: string;
  /** HH:MM delivery window on the day */
  windowStart: string;
  windowEnd: string;
  /** HH:MM on the day, after which unmarked deliveries become unconfirmed */
  dayCloseTime: string;
}

export const DEFAULT_DAY_RULES: DayRules = {
  cutoffTime: '16:00',
  windowStart: '05:30',
  windowEnd: '08:00',
  dayCloseTime: '10:00',
};

export function isYMD(s: string): boolean {
  const m = YMD_RE.exec(s);
  if (!m) return false;
  const [, y, mo, d] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  return new Date(t).toISOString().slice(0, 10) === s;
}

export function isHM(s: string): boolean {
  return HM_RE.test(s);
}

function hmToMinutes(hm: string): number {
  const m = HM_RE.exec(hm);
  if (!m) throw new Error(`not an HH:MM time: "${hm}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** The Asia/Kolkata calendar date an instant falls on. */
export function istYMD(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MIN * MS_PER_MIN).toISOString().slice(0, 10);
}

/** Minutes since Asia/Kolkata midnight for an instant (0..1439). */
export function istMinutes(instant: Date): number {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MIN * MS_PER_MIN);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** The instant of wall time `hm` on Asia/Kolkata date `ymd`. */
export function istInstant(ymd: string, hm: string): Date {
  if (!isYMD(ymd)) throw new Error(`not a YYYY-MM-DD date: "${ymd}"`);
  const [y, mo, d] = ymd.split('-').map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, mo - 1, d);
  return new Date(utcMidnight + (hmToMinutes(hm) - IST_OFFSET_MIN) * MS_PER_MIN);
}

/** Add whole days to a YYYY-MM-DD. */
export function addDaysYMD(ymd: string, n: number): string {
  if (!isYMD(ymd)) throw new Error(`not a YYYY-MM-DD date: "${ymd}"`);
  const [y, mo, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((istInstant(b, '12:00').getTime() - istInstant(a, '12:00').getTime()) / MS_PER_DAY);
}

/** Changes for delivery date `date` close at this instant: cutoffTime on the day before. */
export function lockInstant(date: string, rules: DayRules): Date {
  return istInstant(addDaysYMD(date, -1), rules.cutoffTime);
}

/** True when `date` is past its cutoff at `now` (by time alone — see lib/daylock for the materialised lock). */
export function isPastCutoff(date: string, now: Date, rules: DayRules): boolean {
  return now.getTime() >= lockInstant(date, rules).getTime();
}

/**
 * The earliest delivery date a customer can still change at `now` — pause,
 * unpause, cancel-from, extra milk, and a new plan's first delivery.
 * With a 16:00 cutoff: before 4 PM this is tomorrow, from 4 PM the day after.
 */
export function firstOpenDate(now: Date, rules: DayRules): string {
  let d = istYMD(now);
  // bounded: the cutoff is the day before, so at most two steps are ever needed
  for (let i = 0; i < 3; i++) {
    if (!isPastCutoff(d, now, rules)) return d;
    d = addDaysYMD(d, 1);
  }
  return d;
}

/** Unmarked deliveries for `date` become unconfirmed at this instant. */
export function closeInstant(date: string, rules: DayRules): Date {
  return istInstant(date, rules.dayCloseTime);
}

export function windowInstants(date: string, rules: DayRules): { start: Date; end: Date } {
  return { start: istInstant(date, rules.windowStart), end: istInstant(date, rules.windowEnd) };
}

/** Human label: "4:00 PM". */
export function hmLabel(hm: string): string {
  const mins = hmToMinutes(hm);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * Validate a candidate rule set. Returns human-readable problems; empty = valid.
 * The window must open before it closes, and the day must close after the window
 * ends — otherwise a round that is still out gets marked unconfirmed mid-run.
 */
export function validateDayRules(r: DayRules): string[] {
  const errs: string[] = [];
  for (const k of ['cutoffTime', 'windowStart', 'windowEnd', 'dayCloseTime'] as const) {
    if (!isHM(r[k])) errs.push(`${k} must be HH:MM (24-hour), got "${r[k]}"`);
  }
  if (errs.length) return errs;
  if (hmToMinutes(r.windowStart) >= hmToMinutes(r.windowEnd)) {
    errs.push('windowStart must be before windowEnd');
  }
  if (hmToMinutes(r.dayCloseTime) <= hmToMinutes(r.windowEnd)) {
    errs.push('dayCloseTime must be after windowEnd');
  }
  return errs;
}
