/**
 * Standing routes: each rider's stop order, optimised on real roads (Google Routes
 * API, waypoint optimisation) only when their stop list changes, with the local
 * nearest-neighbour + 2-opt solver (lib/routing) as the fallback.
 *
 * Why "standing": a milk round visits the same doorsteps every morning. Riders learn
 * a stable order, and re-optimising daily would both reshuffle it and cost an API
 * call per rider per day. So:
 *  · the DAILY lock orders the day's stops from the standing route with NO API call
 *    (`orderStopsForRider`): today's stops keep their standing order, absent (paused)
 *    stops are simply skipped, and a stop that is not in the route yet is slotted in
 *    at its cheapest position — and the route is flagged dirty;
 *  · the tick re-optimises dirty routes, and every route at least every 25 days
 *    (Google's terms only allow caching route results for a limited time), within the
 *    cost caps in lib/google-routes.
 */

import type { Db, ObjectId } from 'mongodb';
import { getDb } from './db';
import { col, stopKeyOf, type LatLng, type Rider, type StandingRoute, type Zone } from './models';
import type { OpCtx } from './clock';
import { recordEvent } from './events';
import { centroid, insertAllCheapest, optimizeRoute, pathLengthM, type Waypoint } from './routing';
import { normalizePoint, pointInPolygon } from './geo';
import { computeOptimizedOrder, googleRoutesConfigured, MAX_INTERMEDIATES, type FetchImpl } from './google-routes';
import { NotFoundError, ServiceNotConfiguredError, UpstreamError } from './errors';

export interface StopInput {
  stopKey: string;
  location: LatLng;
}

export interface OrderedStops {
  /** stop keys in visiting order — exactly the input keys, no more, no fewer */
  order: string[];
  source: 'google' | 'local' | 'none';
  totalM?: number;
}

/** Routes older than this are refreshed even when nothing changed. */
export const STALE_DAYS = 25;
const MS_PER_DAY = 86_400_000;

/** Test seam: route Google calls through an injected fetch. */
let fetchOverride: FetchImpl | undefined;
export function __setRoutesFetchForTests(f: FetchImpl | undefined): void {
  fetchOverride = f;
}

interface StopPoint extends Waypoint {
  stopKey: string;
}

/** The farm as a route origin, from env (both or neither). */
export function farmOrigin(): LatLng | null {
  return normalizePoint(process.env.FARM_ORIGIN_LAT, process.env.FARM_ORIGIN_LNG);
}

function originFor(rider: Pick<Rider, 'startLocation'> | null, points: readonly LatLng[]): LatLng | null {
  return rider?.startLocation ?? farmOrigin() ?? centroid(points);
}

/**
 * The doorsteps a rider owns right now: scheduled/active subscriptions with a pin,
 * inside a zone that rider runs. Deduped by stopKey (cow + buffalo at one door is
 * one stop). Subscriptions without a cached zoneId (legacy rows) are matched by
 * point-in-polygon against the rider's zones.
 */
export async function riderStops(riderId: ObjectId, db?: Db): Promise<StopInput[]> {
  const d = db ?? (await getDb());
  const zones = await col.zones(d).find({ riderId, active: true }).toArray();
  if (zones.length === 0) return [];
  const zoneIds = zones.map(z => z._id!).filter(Boolean);

  const subs = await col
    .subscriptions(d)
    .find({
      status: { $in: ['scheduled', 'active'] },
      location: { $exists: true },
      $or: [{ zoneId: { $in: zoneIds } }, { zoneId: { $exists: false } }],
    })
    .project<{ mobile: string; location: LatLng; stopKey?: string; zoneId?: ObjectId }>({
      mobile: 1,
      location: 1,
      stopKey: 1,
      zoneId: 1,
    })
    .toArray();

  const inRiderZone = (p: LatLng): boolean => zones.some((z: Zone) => pointInPolygon(p, z.geometry));
  const byKey = new Map<string, StopInput>();
  for (const s of subs) {
    if (!s.location) continue;
    if (!s.zoneId && !inRiderZone(s.location)) continue;
    const key = s.stopKey ?? stopKeyOf(s.mobile, s.location);
    if (!byKey.has(key)) byKey.set(key, { stopKey: key, location: { lat: s.location.lat, lng: s.location.lng } });
  }
  return [...byKey.values()].sort((a, b) => a.stopKey.localeCompare(b.stopKey));
}

function toPoints(stops: readonly StopInput[]): StopPoint[] {
  return stops.map(s => ({ stopKey: s.stopKey, point: s.location }));
}

function localOrder(origin: LatLng, stops: readonly StopInput[]): { order: string[]; totalM: number } {
  const r = optimizeRoute(origin, toPoints(stops));
  return { order: r.order.map(s => s.stopKey), totalM: Math.round(r.totalM) };
}

/**
 * Order `stops` for `riderId` by their standing route — see the file header.
 * NEVER calls Google (it runs inside the daily lock). riderId null → local order.
 */
export async function orderStopsForRider(riderId: ObjectId | null, stops: StopInput[], ctx: OpCtx): Promise<OrderedStops> {
  if (stops.length === 0) return { order: [], source: 'none' };
  const db = await getDb();
  const unique = [...new Map(stops.map(s => [s.stopKey, s])).values()];
  const rider = riderId ? await col.riders(db).findOne({ _id: riderId }) : null;
  const origin = originFor(rider, unique.map(s => s.location))!;

  if (!riderId) {
    const l = localOrder(origin, unique);
    return { order: l.order, source: 'local', totalM: l.totalM };
  }

  const standing = await col.standingRoutes(db).findOne({ riderId });
  if (!standing || standing.stopOrder.length === 0) {
    await markRouteDirty(riderId, standing ? 'first stops' : 'no standing route', ctx);
    const l = localOrder(origin, unique);
    return { order: l.order, source: 'local', totalM: l.totalM };
  }

  const byKey = new Map(unique.map(s => [s.stopKey, s]));
  const kept: StopPoint[] = standing.stopOrder
    .filter(k => byKey.has(k))
    .map(k => ({ stopKey: k, point: byKey.get(k)!.location }));
  const keptKeys = new Set(kept.map(s => s.stopKey));
  const fresh = toPoints(unique.filter(s => !keptKeys.has(s.stopKey)));

  const ordered = fresh.length ? insertAllCheapest(origin, kept, fresh) : kept;
  if (fresh.length) await markRouteDirty(riderId, `${fresh.length} new stop(s)`, ctx);

  return {
    order: ordered.map(s => s.stopKey),
    source: standing.source,
    totalM: Math.round(pathLengthM(origin, ordered)),
  };
}

interface OptimizeOpts {
  /** at a cost cap: 'fallback' writes a local route, 'skip' writes nothing and returns null */
  onCap: 'fallback' | 'skip';
}

async function optimizeInternal(riderId: ObjectId, ctx: OpCtx, opts: OptimizeOpts): Promise<StandingRoute | null> {
  const db = await getDb();
  const rider = await col.riders(db).findOne({ _id: riderId });
  if (!rider) throw new NotFoundError('Rider not found');

  const stops = await riderStops(riderId, db);
  const origin = originFor(rider, stops.map(s => s.location));

  let order: string[] = [];
  let source: 'google' | 'local' = 'local';
  let totalM: number | undefined;
  let totalS: number | undefined;
  let fallbackReason: string | undefined;

  if (stops.length > 0 && origin) {
    const local = localOrder(origin, stops);
    order = local.order;
    totalM = local.totalM;

    // Google only adds value with 2+ stops; 26+ stops exceed one request's intermediates.
    const eligible = stops.length >= 2 && stops.length - 1 <= MAX_INTERMEDIATES;
    if (eligible && googleRoutesConfigured()) {
      // Fix the destination to the local solver's final stop (an open path needs an
      // end), and let Google order everything in between on real roads.
      const byKey = new Map(stops.map(s => [s.stopKey, s]));
      const destKey = local.order[local.order.length - 1]!;
      const interKeys = local.order.slice(0, -1);
      try {
        const res = await computeOptimizedOrder({
          origin,
          destination: byKey.get(destKey)!.location,
          intermediates: interKeys.map(k => byKey.get(k)!.location),
          now: ctx.now,
          ...(fetchOverride ? { fetchImpl: fetchOverride } : {}),
        });
        if (res === null) {
          if (opts.onCap === 'skip') return null;
          fallbackReason = 'daily/monthly Google cap reached';
        } else {
          order = [...res.order.map(i => interKeys[i]!), destKey];
          source = 'google';
          totalM = res.distanceM;
          totalS = res.durationS;
        }
      } catch (err) {
        if (!(err instanceof UpstreamError) && !(err instanceof ServiceNotConfiguredError)) throw err;
        fallbackReason = err.message;
      }
    }
  }

  const set: Partial<StandingRoute> = {
    stopOrder: order,
    source,
    optimizedAt: ctx.now,
    dirty: false,
    ...(totalM !== undefined ? { totalM } : {}),
    ...(totalS !== undefined ? { totalS } : {}),
  };
  const unset: Record<string, ''> = { dirtyReason: '' };
  if (totalM === undefined) unset.totalM = '';
  if (totalS === undefined) unset.totalS = '';

  const updated = await col.standingRoutes(db).findOneAndUpdate(
    { riderId },
    { $set: set, $unset: unset, $inc: { version: 1 }, $setOnInsert: { riderId } },
    { upsert: true, returnDocument: 'after' },
  );

  await recordEvent(
    ctx,
    {
      entity: 'route',
      entityId: riderId.toHexString(),
      type: 'route.optimized',
      data: {
        stops: order.length,
        source,
        ...(totalM !== undefined ? { totalM } : {}),
        ...(fallbackReason ? { fallbackReason } : {}),
      },
    },
    db,
  );
  return updated;
}

/** Rebuild one rider's standing route from their current stops (Google when configured and under the caps). */
export async function optimizeStandingRoute(riderId: ObjectId, ctx: OpCtx): Promise<StandingRoute> {
  const r = await optimizeInternal(riderId, ctx, { onCap: 'fallback' });
  // onCap 'fallback' never returns null
  return r!;
}

/** Flag a rider's route for re-optimisation (new customer, address change, zone handover). Cheap; never throws. */
export async function markRouteDirty(riderId: ObjectId | null | undefined, reason: string, ctx: OpCtx): Promise<void> {
  if (!riderId) return;
  try {
    const db = await getDb();
    await col.standingRoutes(db).updateOne(
      { riderId },
      {
        $set: { dirty: true, dirtyReason: reason.slice(0, 200) },
        $setOnInsert: { riderId, stopOrder: [], source: 'local', optimizedAt: new Date(0), version: 0 },
      },
      { upsert: true },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[route-plan] markRouteDirty failed', riderId.toHexString(), err instanceof Error ? err.message : err);
  }
  void ctx;
}

/** Tick step: re-optimise dirty routes and routes older than STALE_DAYS, within the cost caps. */
export async function refreshStaleRoutes(ctx: OpCtx): Promise<{ optimized: number; skipped: number; capped: boolean }> {
  const db = await getDb();
  const staleBefore = new Date(ctx.now.getTime() - STALE_DAYS * MS_PER_DAY);
  const due = await col
    .standingRoutes(db)
    .find({ $or: [{ dirty: true }, { optimizedAt: { $lt: staleBefore } }] })
    .sort({ dirty: -1, optimizedAt: 1 })
    .limit(100)
    .toArray();

  let optimized = 0;
  let skipped = 0;
  let capped = false;
  for (const route of due) {
    const rider = await col.riders(db).findOne({ _id: route.riderId });
    if (!rider || !rider.active) {
      skipped++;
      continue;
    }
    const r = await optimizeInternal(route.riderId, ctx, { onCap: 'skip' });
    if (r === null) {
      capped = true;
      break;
    }
    optimized++;
  }
  return { optimized, skipped, capped };
}

/** Admin read model: every active rider's standing route. */
export interface RouteSummary {
  riderId: string;
  name: string;
  stops: number;
  source: 'google' | 'local' | 'none';
  optimizedAt: string | null;
  dirty: boolean;
  dirtyReason?: string;
  totalM?: number;
  totalS?: number;
}

export async function listRouteSummaries(): Promise<RouteSummary[]> {
  const db = await getDb();
  const riders = await col.riders(db).find({ active: true }).sort({ name: 1 }).toArray();
  const routes = await col.standingRoutes(db).find({ riderId: { $in: riders.map(r => r._id!) } }).toArray();
  const byRider = new Map(routes.map(r => [r.riderId.toHexString(), r]));
  return riders.map(r => {
    const s = byRider.get(r._id!.toHexString());
    const never = !s || s.optimizedAt.getTime() === 0;
    return {
      riderId: r._id!.toHexString(),
      name: r.name,
      stops: s?.stopOrder.length ?? 0,
      source: never ? 'none' : s!.source,
      optimizedAt: never ? null : s!.optimizedAt.toISOString(),
      dirty: s?.dirty ?? false,
      ...(s?.dirtyReason ? { dirtyReason: s.dirtyReason } : {}),
      ...(s?.totalM !== undefined ? { totalM: s.totalM } : {}),
      ...(s?.totalS !== undefined ? { totalS: s.totalS } : {}),
    };
  });
}
