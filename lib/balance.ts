/**
 * Day-level load balancing between riders — pure, database-free, unit-tested.
 *
 * Assignment is territorial: a zone belongs to one rider, so a rider delivers to
 * every door in their zones. That keeps the same rider at the same doorstep every
 * morning, which is what customers and riders both want. Territory alone has two
 * gaps, and this module closes them for ONE day at a time:
 *
 *  1. UNASSIGNED stops — a door in a zone with no rider. Instead of nobody
 *     delivering it, it goes to the nearest rider who has room.
 *  2. OVERLOADED riders — more stops or litres than the rider's capacity. They hand
 *     off the doors that sit closest to a neighbouring rider with spare capacity,
 *     one door at a time, until back under capacity.
 *
 * What it deliberately does NOT do:
 *  · touch a rider without a capacity — no capacity means "no limit", so balancing
 *    is opt-in per rider and changes nothing until ops set one;
 *  · send anyone across the city — a handoff must be within `maxHandoffM` of the
 *    receiving rider's nearest stop (or start point); if no one nearby has room the
 *    rider stays overloaded and is reported, for ops to decide;
 *  · change territory — moves are for the day being locked only. Zones and
 *    standing routes are untouched, so tomorrow everyone is back on their own doors.
 *
 * Distances are straight-line (lib/geo distanceM): this ranks which door is
 * nearest to whom, it does not plan the drive (lib/routing does that).
 */

import { distanceM, type GeoPoint } from './geo';

export interface BalanceStop {
  stopKey: string;
  /** stops without a pin cannot be placed, so they never move */
  location?: GeoPoint;
  /** total litres at this door for the day (cow + buffalo) */
  litres: number;
}

export interface BalanceRider {
  /** group key; must match the keys of `groups` */
  key: string;
  /** null for the unassigned bucket */
  riderId: string | null;
  active: boolean;
  maxStops?: number;
  maxLitres?: number;
  /** where the rider starts — the anchor when they have no stops yet today */
  anchor?: GeoPoint;
  /** load already frozen into this rider's run (an earlier lock) — counts toward capacity, never moves */
  fixedStops?: number;
  fixedLitres?: number;
}

export interface BalanceMove {
  stopKey: string;
  from: string;
  to: string;
  /** straight-line metres from the door to the receiver's nearest stop / start */
  distanceM: number;
  reason: 'unassigned' | 'over_capacity';
}

export interface BalanceResult {
  moves: BalanceMove[];
  /** riders still over capacity after balancing (nobody near enough had room) */
  overCapacity: string[];
  /** unassigned stops that found no rider within reach */
  stillUnassigned: string[];
}

export const DEFAULT_MAX_HANDOFF_M = 5000;

interface Load {
  stops: number;
  litres: number;
}

function overBy(load: Load, r: BalanceRider): boolean {
  return (r.maxStops !== undefined && load.stops > r.maxStops) || (r.maxLitres !== undefined && load.litres > r.maxLitres + 1e-9);
}

function canTake(load: Load, r: BalanceRider, stop: BalanceStop): boolean {
  if (!r.active || r.riderId === null) return false;
  if (r.maxStops !== undefined && load.stops + 1 > r.maxStops) return false;
  if (r.maxLitres !== undefined && load.litres + stop.litres > r.maxLitres + 1e-9) return false;
  return true;
}

/** Straight-line distance from `p` to the nearest of the receiver's stops, else its anchor. */
function reach(p: GeoPoint, stops: readonly BalanceStop[], anchor?: GeoPoint): number {
  let best = Infinity;
  for (const s of stops) if (s.location) best = Math.min(best, distanceM(p, s.location));
  if (best === Infinity && anchor) best = distanceM(p, anchor);
  return best;
}

/**
 * Plan the day's moves. `groups` maps each rider key (including the unassigned
 * bucket) to the MOVABLE stops it holds; `riders` describes every candidate rider,
 * including riders with no stops yet (they can still receive). Pure: the inputs are
 * not mutated, and the same input always gives the same moves.
 */
export function planBalance(
  groups: ReadonlyMap<string, readonly BalanceStop[]>,
  riders: ReadonlyMap<string, BalanceRider>,
  opts: { maxHandoffM?: number } = {},
): BalanceResult {
  const maxHandoffM = opts.maxHandoffM ?? DEFAULT_MAX_HANDOFF_M;

  // working copies
  const held = new Map<string, BalanceStop[]>();
  for (const [k, stops] of groups) held.set(k, [...stops].sort((a, b) => a.stopKey.localeCompare(b.stopKey)));
  for (const k of riders.keys()) if (!held.has(k)) held.set(k, []);
  const load = new Map<string, Load>();
  for (const [k, stops] of held) {
    const r = riders.get(k);
    load.set(k, {
      stops: (r?.fixedStops ?? 0) + stops.length,
      litres: (r?.fixedLitres ?? 0) + stops.reduce((s, x) => s + x.litres, 0),
    });
  }

  const moves: BalanceMove[] = [];
  const receivers = [...riders.values()].filter(r => r.active && r.riderId !== null).sort((a, b) => a.key.localeCompare(b.key));

  const move = (stop: BalanceStop, from: string, to: string, d: number, reason: BalanceMove['reason']) => {
    held.set(from, held.get(from)!.filter(s => s.stopKey !== stop.stopKey));
    held.get(to)!.push(stop);
    const lf = load.get(from)!, lt = load.get(to)!;
    lf.stops -= 1; lf.litres -= stop.litres;
    lt.stops += 1; lt.litres += stop.litres;
    moves.push({ stopKey: stop.stopKey, from, to, distanceM: Math.round(d), reason });
  };

  /** nearest receiver (≠ from) that can take `stop` within reach, or null */
  const bestReceiver = (stop: BalanceStop, from: string): { key: string; d: number } | null => {
    if (!stop.location) return null;
    let best: { key: string; d: number } | null = null;
    for (const r of receivers) {
      if (r.key === from || !canTake(load.get(r.key)!, r, stop)) continue;
      const d = reach(stop.location, held.get(r.key)!, r.anchor);
      if (d > maxHandoffM) continue;
      if (!best || d < best.d || (d === best.d && r.key < best.key)) best = { key: r.key, d };
    }
    return best;
  };

  // 1. unassigned bucket(s): every placeable door goes to the nearest rider with room
  const stillUnassigned: string[] = [];
  for (const [k, stops] of [...held]) {
    const r = riders.get(k);
    if (r && r.riderId !== null) continue;
    for (const stop of [...stops]) {
      const to = bestReceiver(stop, k);
      if (to) move(stop, k, to.key, to.d, 'unassigned');
      else stillUnassigned.push(stop.stopKey);
    }
  }

  // 2. overloaded riders, worst first: shed the door that is closest to a neighbour with room
  const overCapacity: string[] = [];
  const donors = receivers
    .filter(r => overBy(load.get(r.key)!, r))
    .sort((a, b) => load.get(b.key)!.stops - load.get(a.key)!.stops || a.key.localeCompare(b.key));
  for (const donor of donors) {
    while (overBy(load.get(donor.key)!, donor)) {
      let pick: { stop: BalanceStop; to: string; d: number } | null = null;
      for (const stop of held.get(donor.key)!) {
        const to = bestReceiver(stop, donor.key);
        if (to && (!pick || to.d < pick.d || (to.d === pick.d && stop.stopKey < pick.stop.stopKey))) {
          pick = { stop, to: to.key, d: to.d };
        }
      }
      if (!pick) break;
      move(pick.stop, donor.key, pick.to, pick.d, 'over_capacity');
    }
    if (overBy(load.get(donor.key)!, donor)) overCapacity.push(donor.key);
  }

  return { moves, overCapacity, stillUnassigned };
}
