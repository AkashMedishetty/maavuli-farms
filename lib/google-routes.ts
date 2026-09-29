/**
 * Google Routes API — waypoint-order optimisation for a rider's standing route.
 *
 * One call: POST https://routes.googleapis.com/directions/v2:computeRoutes with
 * `optimizeWaypointOrder: true`, returning `routes[0].optimizedIntermediateWaypointIndex`
 * (the intermediates' visiting order, indices into the request). Rules from
 * https://developers.google.com/maps/documentation/routes/opt-way :
 *  · no waypoint may have `via: true`, routingPreference must not be
 *    TRAFFIC_AWARE_OPTIMAL — neither is ever sent here;
 *  · at most 25 intermediate waypoints per request (usage limits page).
 *
 * TRAVEL MODE IS DRIVE, deliberately. Waypoint optimisation bills on the
 * "Compute Routes Pro" SKU; two-wheeler routing is an ENTERPRISE feature (a higher
 * rate, and a 1,000/month free cap instead of 5,000). For deciding the ORDER of
 * doorsteps a few hundred metres apart, drive and two-wheeler agree; the rider's
 * actual turn-by-turn navigation still uses two-wheeler mode via free Maps URLs
 * (lib/maps-links).
 *
 * COST GUARDS, both enforced in code BEFORE the network call (Cloud Console quotas
 * should be set too — this is the backstop):
 *  · GOOGLE_ROUTES_DAILY_CAP   (default 100)
 *  · GOOGLE_ROUTES_MONTHLY_CAP (default 3000 — under the 5,000/month free Pro cap)
 * Counters live in `api_usage` and are reserved atomically, so concurrent callers can
 * never overshoot. At a cap the function returns null and the caller uses the local
 * solver instead.
 *
 * The API key is never logged, never put in an error message, never returned.
 */

import type { Db } from 'mongodb';
import { getDb } from './db';
import { col, type LatLng } from './models';
import { istYMD } from './cutoff';
import { ServiceNotConfiguredError, UpstreamError } from './errors';

export const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
export const MAX_INTERMEDIATES = 25;
const TIMEOUT_MS = 10_000;

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface OptimizeInput {
  origin: LatLng;
  destination: LatLng;
  intermediates: readonly LatLng[];
  /** injected in tests; defaults to global fetch */
  fetchImpl?: FetchImpl;
  /** business now, for the usage-counter date */
  now?: Date;
}

export interface OptimizeResult {
  /** permutation of 0..intermediates.length-1 in visiting order */
  order: number[];
  distanceM?: number;
  durationS?: number;
}

function envTrim(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export function googleRoutesConfigured(): boolean {
  return envTrim('GOOGLE_MAPS_SERVER_KEY') !== undefined;
}

function capFrom(name: string, fallback: number): number {
  const raw = envTrim(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  // a malformed cap must not become "unlimited"
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function dailyCap(): number {
  return capFrom('GOOGLE_ROUTES_DAILY_CAP', 100);
}

export function monthlyCap(): number {
  return capFrom('GOOGLE_ROUTES_MONTHLY_CAP', 3000);
}

export function usageKeys(now: Date): { day: string; month: string } {
  const ymd = istYMD(now);
  return { day: `google_routes:${ymd}`, month: `google_routes:${ymd.slice(0, 7)}` };
}

/**
 * Atomically take one unit from a counter if it is below `cap`. The filter only
 * matches below the cap; at the cap the upsert collides with the existing _id
 * (E11000), which is how "full" is detected without a read-then-write race.
 */
async function reserve(db: Db, id: string, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  try {
    await col.apiUsage(db).updateOne({ _id: id, count: { $lt: cap } }, { $inc: { count: 1 } }, { upsert: true });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

async function release(db: Db, id: string): Promise<void> {
  await col.apiUsage(db).updateOne({ _id: id, count: { $gt: 0 } }, { $inc: { count: -1 } });
}

/** Reserve one call against both caps. False = a cap is reached (nothing consumed). */
export async function reserveGoogleCall(now: Date, db?: Db): Promise<boolean> {
  const d = db ?? (await getDb());
  const keys = usageKeys(now);
  if (!(await reserve(d, keys.month, monthlyCap()))) return false;
  if (!(await reserve(d, keys.day, dailyCap()))) {
    await release(d, keys.month);
    return false;
  }
  return true;
}

export async function googleUsage(now: Date, db?: Db): Promise<{ today: number; month: number; dailyCap: number; monthlyCap: number }> {
  const d = db ?? (await getDb());
  const keys = usageKeys(now);
  const [day, month] = await Promise.all([
    col.apiUsage(d).findOne({ _id: keys.day }),
    col.apiUsage(d).findOne({ _id: keys.month }),
  ]);
  return { today: day?.count ?? 0, month: month?.count ?? 0, dailyCap: dailyCap(), monthlyCap: monthlyCap() };
}

const waypoint = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });

/** Pure: the request body. Exported for tests. */
export function buildRequestBody(input: Pick<OptimizeInput, 'origin' | 'destination' | 'intermediates'>): Record<string, unknown> {
  return {
    origin: waypoint(input.origin),
    destination: waypoint(input.destination),
    intermediates: input.intermediates.map(waypoint),
    travelMode: 'DRIVE',
    optimizeWaypointOrder: true,
  };
}

/** Pure: validate and extract the result. Throws UpstreamError on a malformed body. Exported for tests. */
export function parseResponse(body: unknown, intermediateCount: number): OptimizeResult {
  const routes = (body as { routes?: unknown })?.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new UpstreamError('google_routes', 'Google Routes returned no route for these stops');
  }
  const r = routes[0] as { optimizedIntermediateWaypointIndex?: unknown; distanceMeters?: unknown; duration?: unknown };
  let order: number[];
  if (intermediateCount === 0) {
    order = [];
  } else if (intermediateCount === 1 && r.optimizedIntermediateWaypointIndex === undefined) {
    order = [0];
  } else {
    const raw = r.optimizedIntermediateWaypointIndex;
    if (!Array.isArray(raw) || raw.length !== intermediateCount) {
      throw new UpstreamError('google_routes', 'Google Routes returned an unexpected waypoint order');
    }
    order = raw.map(v => Number(v));
    const seen = new Set(order);
    const valid = order.every(i => Number.isInteger(i) && i >= 0 && i < intermediateCount) && seen.size === intermediateCount;
    if (!valid) throw new UpstreamError('google_routes', 'Google Routes returned an unexpected waypoint order');
  }
  const distanceM = typeof r.distanceMeters === 'number' ? r.distanceMeters : undefined;
  const durMatch = typeof r.duration === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(r.duration) : null;
  const durationS = durMatch ? Math.round(Number(durMatch[1])) : undefined;
  return { order, ...(distanceM !== undefined ? { distanceM } : {}), ...(durationS !== undefined ? { durationS } : {}) };
}

/**
 * Ask Google for the best visiting order of `intermediates` between a fixed origin
 * and destination. Returns null when a cost cap is reached (no call made).
 * Throws ServiceNotConfiguredError without a key, UpstreamError on any failure.
 */
export async function computeOptimizedOrder(input: OptimizeInput): Promise<OptimizeResult | null> {
  const key = envTrim('GOOGLE_MAPS_SERVER_KEY');
  if (!key) throw new ServiceNotConfiguredError('Google Routes', ['GOOGLE_MAPS_SERVER_KEY']);
  if (input.intermediates.length > MAX_INTERMEDIATES) {
    throw new UpstreamError('google_routes', `At most ${MAX_INTERMEDIATES} intermediate stops per request`);
  }

  if (!(await reserveGoogleCall(input.now ?? new Date()))) return null;

  const doFetch: FetchImpl = input.fetchImpl ?? ((u, init) => fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(ROUTES_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key,
        'x-goog-fieldmask': 'routes.optimizedIntermediateWaypointIndex,routes.distanceMeters,routes.duration',
      },
      body: JSON.stringify(buildRequestBody(input)),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as { name?: string }).name === 'AbortError';
    throw new UpstreamError('google_routes', aborted ? 'Google Routes timed out' : 'Google Routes could not be reached');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Google's error body can echo request details; keep only the status + short message.
    let detail = '';
    try {
      const b = (await res.json()) as { error?: { status?: string; message?: string } };
      detail = [b.error?.status, b.error?.message?.slice(0, 160)].filter(Boolean).join(': ');
    } catch {
      /* non-JSON error body */
    }
    throw new UpstreamError('google_routes', `Google Routes returned ${res.status}${detail ? ` (${detail})` : ''}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UpstreamError('google_routes', 'Google Routes returned an unreadable response');
  }
  return parseResponse(body, input.intermediates.length);
}
