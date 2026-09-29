/**
 * Google Maps navigation links — PURE (no key, no billing: Maps URLs are free).
 * OWNER: B4 (routing). Keep the signatures; replace the bodies.
 *
 * Google's documented directions URL (https://www.google.com/maps/dir/?api=1) takes
 * at most 9 waypoints plus the destination when it opens in the Google Maps app
 * (3 in a mobile browser). Stops are therefore split into batches of up to 10
 * destinations, each opening turn-by-turn two-wheeler navigation from the phone's
 * current location, in the given order (Maps never reorders URL waypoints).
 */

import type { LatLng } from './models.ts';

export const MAX_STOPS_PER_LINK = 10;

/** Batched multi-stop navigation links, in order. */
export function navigationLinks(stops: readonly LatLng[], batchSize: number = MAX_STOPS_PER_LINK): string[] {
  void stops;
  void batchSize;
  throw new Error('not implemented: navigationLinks (owner B4)');
}

/** Single-stop turn-by-turn link. */
export function stopNavigationUrl(dest: LatLng): string {
  void dest;
  throw new Error('not implemented: stopNavigationUrl (owner B4)');
}
