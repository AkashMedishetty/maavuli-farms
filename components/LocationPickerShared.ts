/**
 * Shared bits for the LocationPicker engines (Leaflet/OSM and Google). Pure: no
 * React, no DOM at module scope, safe to import from any client component.
 */

/** What the picker hands back: the exact doorstep. */
export interface PickedLocation {
  lat: number;
  lng: number;
  /** metres, only when the point came from the phone's GPS (a dragged pin has none) */
  accuracyM?: number;
  /** human text for the point, e.g. a searched society name or place address */
  label?: string;
}

/** Props every map engine accepts. The engine keeps its marker in sync with `value`. */
export interface EngineProps {
  value: PickedLocation | null;
  onChange: (v: PickedLocation) => void;
  /** unique prefix for element ids (label/input pairs) */
  idPrefix: string;
}

/** Secunderabad, near the farm. Only the initial map centre — never a default pin. */
export const DEFAULT_CENTRE = { lat: 17.4735, lng: 78.5468 } as const;

/** Above this, GPS is not good enough to find a door — ask for a drag. */
export const ACCURACY_OK_M = 50;

/** ~0.1 m at this latitude; enough for a doorstep, and stable across re-saves. */
export function roundCoord(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function samePoint(a: { lat: number; lng: number } | null, b: { lat: number; lng: number } | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;
}

/** Move a point by metres (north/east positive). Used by the keyboard nudge buttons. */
export function nudge(p: { lat: number; lng: number }, northM: number, eastM: number): { lat: number; lng: number } {
  const dLat = northM / 111_320;
  const dLng = eastM / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: roundCoord(p.lat + dLat), lng: roundCoord(p.lng + dLng) };
}
