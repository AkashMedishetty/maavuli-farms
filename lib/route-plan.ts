/**
 * Standing routes: each rider's stop order, optimised on real roads (Google Routes
 * API, waypoint optimisation) only when their stop list changes, with the local
 * nearest-neighbour + 2-opt solver (lib/routing) as the fallback.
 * OWNER: B4 (routing). Keep the signatures; replace the bodies.
 */

import type { ObjectId } from 'mongodb';
import type { LatLng, StandingRoute } from './models';
import type { OpCtx } from './clock';

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

/**
 * Order `stops` for `riderId` by their standing route: known stops keep their
 * standing order, stops not in it are inserted at the cheapest position (and the
 * route is marked dirty for the next refresh), stops absent today are skipped.
 * NEVER calls Google — it is used by the lock job every day. riderId null → local order.
 */
export async function orderStopsForRider(riderId: ObjectId | null, stops: StopInput[], ctx: OpCtx): Promise<OrderedStops> {
  void riderId;
  void stops;
  void ctx;
  throw new Error('not implemented: orderStopsForRider (owner B4)');
}

/** Rebuild one rider's standing route from their current stops (Google when configured and under the daily cap). */
export async function optimizeStandingRoute(riderId: ObjectId, ctx: OpCtx): Promise<StandingRoute> {
  void riderId;
  void ctx;
  throw new Error('not implemented: optimizeStandingRoute (owner B4)');
}

/** Flag a rider's route for re-optimisation (new customer, address change, zone handover). Cheap; never throws. */
export async function markRouteDirty(riderId: ObjectId | null | undefined, reason: string, ctx: OpCtx): Promise<void> {
  void riderId;
  void reason;
  void ctx;
  throw new Error('not implemented: markRouteDirty (owner B4)');
}

/** Tick step: re-optimise dirty routes and routes older than 25 days, within the daily API cap. */
export async function refreshStaleRoutes(ctx: OpCtx): Promise<{ optimized: number; skipped: number; capped: boolean }> {
  void ctx;
  throw new Error('not implemented: refreshStaleRoutes (owner B4)');
}
