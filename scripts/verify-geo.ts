/**
 * Assertions for lib/geo.ts. Same spirit as verify-pricing.ts: the geometry is
 * load-bearing for a delivery promise, so it is checked rather than assumed.
 *
 *   pnpm test:geo
 */
import {
  normalizePoint,
  circleToPolygon,
  pointsToPolygon,
  pointInPolygon,
  distanceM,
  mapsUrl,
  type GeoPoint,
} from '../lib/geo.ts';

let pass = 0;
const fails: string[] = [];

function ok(label: string, cond: boolean): void {
  if (cond) pass++;
  else fails.push(label);
}
function near(label: string, got: number, want: number, tol: number): void {
  ok(`${label} (got ${got.toFixed(3)}, want ${want}±${tol})`, Math.abs(got - want) <= tol);
}

// Safilguda, Secunderabad — the business address's rough locality. Used only as a
// test fixture; it is not a serviceability claim.
const CENTRE: GeoPoint = { lat: 17.4735, lng: 78.5468 };

/* ---- normalizePoint rejects the things that silently corrupt geo data ---- */
ok('accepts a real point', normalizePoint(17.4735, 78.5468) !== null);
ok('accepts numeric strings', normalizePoint('17.4735', '78.5468') !== null);
ok('rejects empty string (Number("") is 0 — the classic bug)', normalizePoint('', '') === null);
ok('rejects NaN', normalizePoint(NaN, 10) === null);
ok('rejects Infinity', normalizePoint(Infinity, 10) === null);
ok('rejects null island (0,0)', normalizePoint(0, 0) === null);
ok('rejects lat > 90', normalizePoint(91, 10) === null);
ok('rejects lng < -180', normalizePoint(10, -181) === null);
ok('rejects undefined', normalizePoint(undefined, undefined) === null);

/* ---- distance sanity ---- */
near('distance to self is 0', distanceM(CENTRE, CENTRE), 0, 0.001);
// 0.01 degree of latitude is ~1.11 km anywhere on Earth
near(
  '0.01 deg latitude is ~1113m',
  distanceM(CENTRE, { lat: CENTRE.lat + 0.01, lng: CENTRE.lng }),
  1113,
  6,
);

/* ---- circleToPolygon: every vertex must sit on the circle ---- */
const RADIUS = 3000;
const circle = circleToPolygon(CENTRE, RADIUS, 64);
const ring = circle.coordinates[0]!;
ok('ring is closed', ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1]);
ok('ring has segments+1 points', ring.length === 65);

let worst = 0;
for (const c of ring) {
  const d = distanceM(CENTRE, { lat: c[1]!, lng: c[0]! });
  worst = Math.max(worst, Math.abs(d - RADIUS));
}
near('every vertex is on the circle', worst, 0, 1.5);

/* ---- winding must be counter-clockwise, or Mongo can select the COMPLEMENT ---- */
let signed = 0;
for (let i = 0; i < ring.length - 1; i++) {
  const [x1, y1] = ring[i]!;
  const [x2, y2] = ring[i + 1]!;
  signed += x1! * y2! - x2! * y1!;
}
ok(`exterior ring is counter-clockwise (signed area ${signed > 0 ? '+' : '-'})`, signed > 0);

/* ---- containment ---- */
ok('centre is inside', pointInPolygon(CENTRE, circle));
// due north, comfortably inside and comfortably outside
const inside: GeoPoint = { lat: CENTRE.lat + 0.018, lng: CENTRE.lng }; // ~2.0 km
const outside: GeoPoint = { lat: CENTRE.lat + 0.045, lng: CENTRE.lng }; // ~5.0 km
ok(`~${(distanceM(CENTRE, inside) / 1000).toFixed(1)}km is inside a 3km zone`, pointInPolygon(inside, circle));
ok(`~${(distanceM(CENTRE, outside) / 1000).toFixed(1)}km is outside a 3km zone`, !pointInPolygon(outside, circle));

// east/west too, to catch a lat/lng transposition
const eastIn: GeoPoint = { lat: CENTRE.lat, lng: CENTRE.lng + 0.018 };
const eastOut: GeoPoint = { lat: CENTRE.lat, lng: CENTRE.lng + 0.05 };
ok('inside to the east', pointInPolygon(eastIn, circle));
ok('outside to the east', !pointInPolygon(eastOut, circle));

/* ---- a transposed coordinate must NOT quietly be serviceable ---- */
const transposed: GeoPoint = { lat: CENTRE.lng, lng: CENTRE.lat }; // 78.5N, 17.5E — Arctic
ok('lat/lng transposition falls outside the zone', !pointInPolygon(transposed, circle));

/* ---- hand-drawn polygon ---- */
const poly = pointsToPolygon([
  { lat: 17.46, lng: 78.53 },
  { lat: 17.49, lng: 78.53 },
  { lat: 17.49, lng: 78.57 },
  { lat: 17.46, lng: 78.57 },
]);
ok('hand-drawn ring is closed', poly.coordinates[0]!.length === 5);
ok('point inside hand-drawn box', pointInPolygon({ lat: 17.475, lng: 78.55 }, poly));
ok('point outside hand-drawn box', !pointInPolygon({ lat: 17.52, lng: 78.55 }, poly));

/* ---- rejects a nonsense radius rather than storing a degenerate zone ---- */
for (const bad of [0, -5, NaN]) {
  let threw = false;
  try {
    circleToPolygon(CENTRE, bad as number);
  } catch {
    threw = true;
  }
  ok(`radius ${bad} throws`, threw);
}

/* ---- rider link ---- */
ok('maps url carries lat,lng in that order', mapsUrl(CENTRE).endsWith('17.4735,78.5468'));

console.log(`\ngeo: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL', f);
process.exit(fails.length ? 1 : 0);
