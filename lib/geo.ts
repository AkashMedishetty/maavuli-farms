/**
 * Geo primitives for delivery-area checks.
 *
 * TWO CONVENTIONS, AND THEY DISAGREE — this is the single biggest source of bugs
 * in geo code, so it is stated once here and obeyed everywhere:
 *
 *   · Humans, browsers and this module's public API use  { lat, lng }.
 *   · GeoJSON and MongoDB use positional arrays in  [lng, lat]  order.
 *
 * Every conversion between the two goes through `toGeoJSON` / `fromGeoJSON` below.
 * Nothing else should ever hand-write a coordinate pair.
 */

/** Mean Earth radius in metres (IUGG). */
const R = 6371008.8;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** A GeoJSON position: [longitude, latitude]. */
export type Position = [number, number];

export interface GeoPolygon {
  type: 'Polygon';
  /** first ring is the exterior; we never emit holes */
  coordinates: Position[][];
}

/**
 * Validate a coordinate pair. Returns null rather than throwing, and rejects
 * anything non-finite — `Number('')` is 0, which would silently place a customer
 * off the coast of Africa at (0, 0) instead of failing.
 */
export function normalizePoint(lat: unknown, lng: unknown): GeoPoint | null {
  const la = typeof lat === 'string' ? Number(lat) : lat;
  const ln = typeof lng === 'string' ? Number(lng) : lng;
  if (typeof la !== 'number' || typeof ln !== 'number') return null;
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
  // (0,0) is a valid point in the Gulf of Guinea but is overwhelmingly a parsing
  // accident in an Indian delivery app, so refuse it explicitly.
  if (la === 0 && ln === 0) return null;
  return { lat: la, lng: ln };
}

export const toGeoJSON = (p: GeoPoint): Position => [p.lng, p.lat];
export const fromGeoJSON = (c: Position): GeoPoint => ({ lat: c[1], lng: c[0] });

/** Great-circle distance in metres. */
export function distanceM(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Approximate a circle as a GeoJSON polygon.
 *
 * MongoDB cannot store a circle as GeoJSON — `$centerSphere` exists only as a
 * QUERY operator, and it asks "which stored points fall in this circle", which is
 * the opposite of what we need ("does this one point fall in a stored zone").
 * Storing the circle as a polygon lets both circular and hand-drawn zones be
 * answered by ONE `$geoIntersects` query instead of two code paths.
 *
 * Uses the spherical destination-point formula rather than a flat lat/lng offset,
 * so the shape stays a true circle instead of squashing as latitude increases.
 *
 * Winding is counter-clockwise to satisfy the GeoJSON right-hand rule: for a ring
 * wound the wrong way MongoDB can select the COMPLEMENT of the intended area —
 * i.e. "everywhere on Earth except this zone" — which fails open, the one failure
 * mode a delivery-area check must never have.
 */
export function circleToPolygon(centre: GeoPoint, radiusM: number, segments = 64): GeoPolygon {
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new Error(`circleToPolygon: radius must be a positive number of metres, got ${radiusM}`);
  }
  const n = Math.max(12, Math.min(512, Math.floor(segments)));
  const d = radiusM / R; // angular radius
  const lat1 = rad(centre.lat);
  const lng1 = rad(centre.lng);

  const ring: Position[] = [];
  for (let i = 0; i < n; i++) {
    // NEGATIVE step: bearing 0=N, 90=E, so increasing bearing traces clockwise.
    // Decreasing traces counter-clockwise, which is the winding GeoJSON wants.
    const brg = rad(-(360 * i) / n);
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg),
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    ring.push([Number(deg(lng2).toFixed(7)), Number(deg(lat2).toFixed(7))]);
  }
  // GeoJSON requires the ring be explicitly closed.
  ring.push([...ring[0]!] as Position);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Close and normalise a hand-drawn ring into a GeoJSON polygon. */
export function pointsToPolygon(points: GeoPoint[]): GeoPolygon {
  if (points.length < 3) throw new Error('pointsToPolygon: need at least 3 points');
  const ring: Position[] = points.map(toGeoJSON);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first] as Position);
  return { type: 'Polygon', coordinates: [ring] };
}

/**
 * Ray-casting containment test, in plane coordinates.
 *
 * This is NOT the authority — MongoDB's spherical `$geoIntersects` is. It exists so
 * the zone maths can be unit-tested without a database, and as a sanity check on
 * seeded data. Over a city-sized zone the planar and spherical answers agree; near
 * a pole or the antimeridian they would not, and there the database wins.
 */
export function pointInPolygon(p: GeoPoint, poly: GeoPolygon): boolean {
  const ring = poly.coordinates[0];
  if (!ring) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const [xi, yi] = [a[0], a[1]];
    const [xj, yj] = [b[0], b[1]];
    const straddles = yi > p.lat !== yj > p.lat;
    if (straddles && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A link the delivery rider can open in any maps app. No API key, works offline-ish. */
export function mapsUrl(p: GeoPoint): string {
  return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
}
