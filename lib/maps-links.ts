/**
 * Google Maps navigation links — PURE (no key, no billing: Maps URLs are free).
 *
 * Google's documented directions URL (https://www.google.com/maps/dir/?api=1) takes
 * at most 9 waypoints plus the destination when it opens in the Google Maps app
 * (3 in a mobile browser). Stops are therefore split into batches of up to 10
 * destinations, each opening turn-by-turn two-wheeler navigation from the phone's
 * current location, in the given order (Maps never reorders URL waypoints).
 *
 * No `origin` parameter on purpose: without one Maps uses the device's location,
 * and `dir_action=navigate` then starts turn-by-turn instead of a route preview.
 *
 * Source: https://developers.google.com/maps/documentation/urls/get-started
 * (parameters, waypoint limits, 2,048-character cap, two-wheeler travel mode).
 */

import type { LatLng } from './models.ts';

export const MAX_STOPS_PER_LINK = 10;
/** Google's documented cap on a Maps URL. */
export const MAX_URL_LENGTH = 2048;

const BASE = 'https://www.google.com/maps/dir/?';

function coord(p: LatLng): string {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
    throw new Error(`maps-links: invalid coordinate ${JSON.stringify(p)}`);
  }
  return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

function build(destination: LatLng, waypoints: readonly LatLng[]): string {
  const params = new URLSearchParams();
  params.set('api', '1');
  params.set('destination', coord(destination));
  // URLSearchParams encodes ',' as %2C and '|' as %7C, which is what Google asks for
  if (waypoints.length > 0) params.set('waypoints', waypoints.map(coord).join('|'));
  params.set('travelmode', 'two-wheeler');
  params.set('dir_action', 'navigate');
  const url = BASE + params.toString();
  if (url.length > MAX_URL_LENGTH) {
    throw new Error(`maps-links: URL is ${url.length} chars, over Google's ${MAX_URL_LENGTH} limit`);
  }
  return url;
}

/**
 * Batched multi-stop navigation links, in order. Each link covers up to
 * `batchSize` consecutive stops: the last stop of the batch is the destination and
 * the ones before it are waypoints. Empty input → no links.
 */
export function navigationLinks(stops: readonly LatLng[], batchSize: number = MAX_STOPS_PER_LINK): string[] {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_STOPS_PER_LINK) {
    throw new Error(`maps-links: batchSize must be an integer between 1 and ${MAX_STOPS_PER_LINK}`);
  }
  const links: string[] = [];
  for (let i = 0; i < stops.length; i += batchSize) {
    const batch = stops.slice(i, i + batchSize);
    const destination = batch[batch.length - 1]!;
    links.push(build(destination, batch.slice(0, -1)));
  }
  return links;
}

/** Single-stop turn-by-turn link. */
export function stopNavigationUrl(dest: LatLng): string {
  return build(dest, []);
}
