/**
 * Assertions for lib/routing.ts. The route optimiser decides the order a rider
 * drives the morning round, so its guarantees are checked, not assumed: the output
 * is a real permutation of the input (no stop dropped or duplicated), 2-opt never
 * makes a route longer, and it actually removes a crossing.
 *
 *   pnpm test:routing     (package.json: node --experimental-strip-types)
 */
import {
  nearestNeighbourOrder,
  twoOptImprove,
  optimizeRoute,
  pathLengthM,
  centroid,
  directionsUrl,
  type Waypoint,
} from '../lib/routing.ts';
import type { GeoPoint } from '../lib/geo.ts';

let pass = 0;
const fails: string[] = [];

function ok(label: string, cond: boolean): void {
  if (cond) pass++;
  else fails.push(label);
}

interface Stop extends Waypoint {
  id: string;
}
const stop = (id: string, lat: number, lng: number): Stop => ({ id, point: { lat, lng } });

/** A route is valid only if it visits every input stop exactly once. */
function isPermutation(input: readonly Stop[], out: readonly Stop[]): boolean {
  if (input.length !== out.length) return false;
  const a = [...input.map(s => s.id)].sort();
  const b = [...out.map(s => s.id)].sort();
  return a.every((id, i) => id === b[i]);
}

/* ---- trivial sizes never throw and are returned as-is ---- */
{
  const origin: GeoPoint = { lat: 0, lng: 0 };
  ok('0 stops -> empty order', optimizeRoute(origin, []).order.length === 0);
  const one = [stop('a', 0.01, 0.01)];
  const r1 = optimizeRoute(origin, one);
  ok('1 stop -> that stop', r1.order.length === 1 && r1.order[0]!.id === 'a');
  ok('1 stop total = origin->stop', Math.abs(r1.totalM - pathLengthM(origin, one)) < 1e-6);
}

/* ---- collinear points are ordered along the line from a start at one end ---- */
{
  const origin: GeoPoint = { lat: 0, lng: 0 };
  // scrambled input, all on the equator at increasing longitude
  const stops = [
    stop('d', 0, 0.04),
    stop('b', 0, 0.02),
    stop('a', 0, 0.01),
    stop('c', 0, 0.03),
  ];
  const order = optimizeRoute(origin, stops).order;
  ok('collinear: permutation preserved', isPermutation(stops, order));
  ok(
    'collinear: visited nearest-to-farthest',
    order.map(s => s.id).join('') === 'abcd',
  );
}

/* ---- nearest neighbour is a permutation and optimize never beats-then-loses it ---- */
{
  const origin: GeoPoint = { lat: 17.47, lng: 78.54 };
  const stops = [
    stop('n1', 17.48, 78.55),
    stop('n2', 17.46, 78.53),
    stop('n3', 17.49, 78.56),
    stop('n4', 17.45, 78.52),
    stop('n5', 17.475, 78.545),
    stop('n6', 17.44, 78.5),
  ];
  const nn = nearestNeighbourOrder(origin, stops);
  ok('NN is a permutation', isPermutation(stops, nn));
  const nnLen = pathLengthM(origin, nn);
  const opt = optimizeRoute(origin, stops);
  ok('optimize is a permutation', isPermutation(stops, opt.order));
  ok('2-opt is never worse than nearest neighbour', opt.totalM <= nnLen + 1e-6);
  ok('legs sum to total', Math.abs(opt.legsM.reduce((a, b) => a + b, 0) - opt.totalM) < 1e-6);
}

/* ---- 2-opt actually removes a crossing ---- */
{
  // four corners of a small square; origin just below corner p0
  const origin: GeoPoint = { lat: -0.01, lng: 0 };
  const p0 = stop('p0', 0, 0);
  const p1 = stop('p1', 0, 0.01);
  const p2 = stop('p2', 0.01, 0.01);
  const p3 = stop('p3', 0.01, 0);
  // a deliberately self-crossing order (the two diagonals)
  const crossing = [p0, p2, p1, p3];
  const crossingLen = pathLengthM(origin, crossing);
  const fixed = twoOptImprove(origin, crossing);
  ok('2-opt keeps every stop', isPermutation(crossing, fixed));
  ok('2-opt shortens a crossing route', pathLengthM(origin, fixed) < crossingLen - 1e-6);
}

/* ---- centroid ---- */
{
  ok('centroid of nothing is null', centroid([]) === null);
  const c = centroid([
    { lat: 0, lng: 0 },
    { lat: 2, lng: 4 },
  ]);
  ok('centroid averages', c !== null && Math.abs(c.lat - 1) < 1e-9 && Math.abs(c.lng - 2) < 1e-9);
}

/* ---- directions url ---- */
{
  const origin: GeoPoint = { lat: 17.47, lng: 78.54 };
  const pts: GeoPoint[] = [
    { lat: 17.48, lng: 78.55 },
    { lat: 17.49, lng: 78.56 },
  ];
  const url = directionsUrl(origin, pts);
  ok('dir url uses the maps dir path form', url.startsWith('https://www.google.com/maps/dir/'));
  ok('dir url starts at the origin', url.includes('17.470000,78.540000'));
  ok('dir url includes each stop', url.includes('17.480000,78.550000') && url.includes('17.490000,78.560000'));
  // path after /maps/dir/ is origin + 2 stops = 3 coordinate segments
  ok('dir url segment count = origin + stops', url.split('/dir/')[1]!.split('/').length === 3);
}

console.log(`\nrouting: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL', f);
process.exit(fails.length ? 1 : 0);
