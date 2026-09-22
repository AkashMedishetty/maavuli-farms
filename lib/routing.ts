/**
 * Delivery route optimisation — pure, database-free, unit-testable.
 *
 * The problem is an OPEN travelling-salesman path: a rider leaves one origin (the
 * farm, or their own start point) and visits every stop once. There is no return
 * leg — the van does not have to come back to where it started for the sequence to
 * be good — so the cost of an order is origin→s0→s1→…→sn, nothing added at the end.
 *
 * TSP is NP-hard, but a morning milk round is tens of stops, not thousands, and it
 * does not need the true optimum — it needs an order a human would not be
 * embarrassed by. So we use the standard cheap-and-good pair:
 *
 *   1. NEAREST NEIGHBOUR builds a first order — always drive to the closest unvisited
 *      stop. Fast, but it paints itself into corners (the last leg is often a long
 *      hop back across everything).
 *   2. 2-OPT then repairs those crossings — repeatedly reverse a sub-path when doing
 *      so shortens the total. This removes the self-intersections nearest-neighbour
 *      leaves and gets within a few percent of optimal on real coordinates.
 *
 * Distance is great-circle metres from lib/geo (`distanceM`). Straight-line, not
 * road distance — we deliberately do NOT call a routing API here: it would need a
 * key, a network round trip and a budget, and for ordering nearby stops the
 * as-the-crow-flies order almost always matches the drive order. The optimiser
 * returns the order; a maps deep link (see `directionsUrl`) hands the actual turn
 * navigation to whatever maps app the rider already uses.
 */

import { distanceM, type GeoPoint } from './geo.ts';

/** Anything with a delivery point can be sequenced. Callers attach their own data. */
export interface Waypoint {
  point: GeoPoint;
}

export interface OptimizedRoute<S extends Waypoint> {
  /** the stops in the order they should be visited */
  order: S[];
  /**
   * Distance of each leg in metres. `legsM[i]` is the hop INTO `order[i]`:
   * `legsM[0]` is origin→order[0], `legsM[1]` is order[0]→order[1], and so on.
   */
  legsM: number[];
  /** total metres travelled, origin through every stop in order (no return leg) */
  totalM: number;
}

/** Total length of origin→stops[0]→stops[1]→…, in metres. No return to origin. */
export function pathLengthM(origin: GeoPoint, stops: readonly Waypoint[]): number {
  let total = 0;
  let prev = origin;
  for (const s of stops) {
    total += distanceM(prev, s.point);
    prev = s.point;
  }
  return total;
}

/** Greedy nearest-neighbour order from the origin. Does not mutate the input. */
export function nearestNeighbourOrder<S extends Waypoint>(origin: GeoPoint, stops: readonly S[]): S[] {
  const remaining = [...stops];
  const order: S[] = [];
  let prev = origin;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = distanceM(prev, remaining[i]!.point);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0]!;
    order.push(next);
    prev = next.point;
  }
  return order;
}

/**
 * 2-opt improvement on an open path from a fixed origin. Repeatedly reverses the
 * segment [i..k] whenever that shortens the total, until a full pass makes no
 * improvement (a local optimum) or the safety cap is hit.
 *
 * Skipped above `MAX_2OPT` stops: the pass is O(n²) and each candidate re-measures
 * a segment, so on a very large round the nearest-neighbour order alone is returned
 * rather than spending seconds a 5am screen does not have. A real round never
 * approaches that size per rider.
 */
const MAX_2OPT = 150;

export function twoOptImprove<S extends Waypoint>(origin: GeoPoint, initial: readonly S[]): S[] {
  const order = [...initial];
  const n = order.length;
  if (n < 3 || n > MAX_2OPT) return order;

  const pointAt = (idx: number): GeoPoint => (idx < 0 ? origin : order[idx]!.point);

  let improved = true;
  let guard = 0;
  const maxPasses = n; // each pass is O(n²); n passes is the usual 2-opt bound
  while (improved && guard < maxPasses) {
    improved = false;
    guard++;
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        // Reversing order[i..k] only changes two boundary edges:
        //   before: (i-1 → i)          + (k → k+1)
        //   after:  (i-1 → k)          + (i → k+1)
        // The k+1 edge is absent when k is the last stop (open path, no tail edge).
        const a = pointAt(i - 1);
        const b = order[i]!.point;
        const c = order[k]!.point;
        const before = distanceM(a, b) + (k + 1 < n ? distanceM(c, order[k + 1]!.point) : 0);
        const after = distanceM(a, c) + (k + 1 < n ? distanceM(b, order[k + 1]!.point) : 0);
        if (after + 1e-6 < before) {
          reverseInPlace(order, i, k);
          improved = true;
        }
      }
    }
  }
  return order;
}

function reverseInPlace<T>(arr: T[], i: number, k: number): void {
  while (i < k) {
    const tmp = arr[i]!;
    arr[i] = arr[k]!;
    arr[k] = tmp;
    i++;
    k--;
  }
}

/**
 * Order a set of stops for one rider from one origin: nearest neighbour, then 2-opt.
 * Returns the visiting order with per-leg and total distances.
 */
export function optimizeRoute<S extends Waypoint>(origin: GeoPoint, stops: readonly S[]): OptimizedRoute<S> {
  const order = twoOptImprove(origin, nearestNeighbourOrder(origin, stops));

  const legsM: number[] = [];
  let prev = origin;
  for (const s of order) {
    legsM.push(distanceM(prev, s.point));
    prev = s.point;
  }
  const totalM = legsM.reduce((a, b) => a + b, 0);
  return { order, legsM, totalM };
}

/** Centre of mass of some points — the fallback origin when no farm/start is set. */
export function centroid(points: readonly GeoPoint[]): GeoPoint | null {
  if (points.length === 0) return null;
  let lat = 0;
  let lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
}

/**
 * A Google Maps directions deep link that chains the whole ordered route, origin
 * first. Uses the /maps/dir/ path form (lat,lng segments) rather than the
 * waypoints query parameter, because the path form carries many more stops before
 * Google truncates and needs no API key.
 *
 * Google stops honouring the link past roughly two dozen points, so it is capped:
 * the returned URL covers the first `MAX_DIR_POINTS` stops in order, and the caller
 * still shows the full ordered list, which is the authority. A single stop with no
 * others just deep-links to that point.
 */
const MAX_DIR_POINTS = 24;

export function directionsUrl(origin: GeoPoint, orderedPoints: readonly GeoPoint[]): string {
  const seg = (p: GeoPoint) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const pts = [origin, ...orderedPoints].slice(0, MAX_DIR_POINTS);
  return `https://www.google.com/maps/dir/${pts.map(seg).join('/')}`;
}
