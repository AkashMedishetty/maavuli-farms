/**
 * Pure helpers for the rider app — no browser APIs, no clock reads (callers pass
 * `now`), so scripts/verify-rider-ui.ts can exercise them in Node.
 */

export interface ProgressStop {
  done: boolean;
  items: { deliveryId: string; status: string }[];
}

/** Progress counts STOPS, not items (matches lib/rider.ts getRiderToday). */
export function stopProgress(stops: readonly { done: boolean }[]): { total: number; done: number } {
  return { total: stops.length, done: stops.filter(s => s.done).length };
}

/**
 * Optimistically mark the stop holding `deliveryId` as done with outcome `type`,
 * then recompute progress per stop. Marking a second item of the same stop does
 * not advance the counter again.
 */
export function applyOptimisticOutcome<
  S extends ProgressStop,
  T extends { stops: S[]; progress: { total: number; done: number } },
>(today: T, deliveryId: string, type: string): T {
  const stops = today.stops.map(s =>
    s.items.some(i => i.deliveryId === deliveryId)
      ? { ...s, done: true, items: s.items.map(i => ({ ...i, status: type })) }
      : s,
  );
  return { ...today, stops, progress: stopProgress(stops) };
}

/* ------------------------------------------------------ server action result */

export interface ActionResultLike {
  ok: boolean;
  error?: string;
  retryable?: boolean;
  duplicate?: boolean;
}

/**
 * How the client treats one /api/rider/actions result:
 *  · ok (incl. duplicate) → done, drop from the queue
 *  · retryable:true       → keep queued, back off
 *  · anything else        → PERMANENT rejection: drop and tell the rider
 * A missing result is treated as retryable (the batch did not answer for it).
 */
export function classifyResult(r: ActionResultLike | undefined): 'ok' | 'retry' | 'rejected' {
  if (!r) return 'retry';
  if (r.ok) return 'ok';
  if (r.retryable === true) return 'retry';
  return 'rejected';
}

export interface RejectedAction {
  actionId: string;
  deliveryId: string;
  error: string;
}

/**
 * One line for the rider about permanently rejected actions, counted per stop.
 * e.g. "1 stop was not saved: Only today's stops can be changed from the app. …"
 */
export function rejectionMessage(
  rejected: readonly RejectedAction[],
  stops: readonly { stopKey: string; items: { deliveryId: string }[] }[],
): string | null {
  if (rejected.length === 0) return null;
  const keys = new Set<string>();
  for (const r of rejected) {
    const stop = stops.find(s => s.items.some(i => i.deliveryId === r.deliveryId));
    keys.add(stop ? stop.stopKey : `d:${r.deliveryId}`);
  }
  const n = keys.size;
  const reasons = Array.from(new Set(rejected.map(r => r.error.trim()).filter(Boolean)));
  const head = n === 1 ? '1 stop was not saved' : `${n} stops were not saved`;
  return reasons.length ? `${head}: ${reasons.join(' · ')}` : `${head}.`;
}

/* ------------------------------------------------------------ dates / units */

const IST_OFFSET_MS = 330 * 60_000;

/** The Asia/Kolkata calendar date (YYYY-MM-DD) an instant falls on. */
export function istDate(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The cached round is only usable when it is for today's IST date. */
export function usableCachedRound<T extends { date?: unknown }>(cached: T | null | undefined, now: Date): T | null {
  if (!cached || typeof cached.date !== 'string') return null;
  return cached.date === istDate(now) ? cached : null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "2026-09-29" (an Asia/Kolkata calendar date) → "Tue 29 Sep". Fixed tables rather
 * than Intl: ICU prints "Sept" for en-IN/en-GB and differs across Android versions.
 * Falls back to the input if unparseable.
 */
export function formatRoundDate(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  // The string already is the IST date; noon UTC on it has the same weekday.
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Litres rounded to 0.1 with no float noise: 4.199999 → "4.2", 5 → "5". */
export function formatLitres(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 10) / 10;
  return String(Object.is(r, -0) ? 0 : r);
}
