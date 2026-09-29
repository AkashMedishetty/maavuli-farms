/**
 * Pure rider logic — NO DB, NO @/... imports beyond pure models/geo, so
 * scripts/verify-rider.ts can unit-test it with tsx and relative imports.
 *
 * These are the decisions the rider flow makes that are worth testing in isolation:
 * whether a delivered tap is flagged, whether an action is well-formed, which fault
 * a reason maps to (and who may override it), and how an offline queue merges a
 * replay of the same actionId.
 */

import { distanceM, type GeoPoint } from './geo.ts';
import { REASON_FAULT, type Fault, type NotDeliveredReason } from './models.ts';

/** Metres from the pin to the tap, rounded, or null when either point is missing. */
export function distanceFromPinM(pin: GeoPoint | undefined, tap: { lat?: number; lng?: number }): number | null {
  if (!pin) return null;
  if (typeof tap.lat !== 'number' || typeof tap.lng !== 'number') return null;
  return Math.round(distanceM({ lat: tap.lat, lng: tap.lng }, pin));
}

/**
 * Should a delivered tap be flagged? Flagged when there is no photo, or the tap is
 * further than the threshold from the pin.
 */
export function isDeliveryFlagged(opts: {
  hasPhoto: boolean;
  distanceM: number | null;
  flagThresholdM: number;
}): boolean {
  if (!opts.hasPhoto) return true;
  if (opts.distanceM !== null && opts.distanceM > opts.flagThresholdM) return true;
  return false;
}

/** A delivered tap needs a photo OR a non-empty note. */
export function deliveredProofOk(hasPhoto: boolean, note: string | undefined): boolean {
  return hasPhoto || (typeof note === 'string' && note.trim() !== '');
}

/** Resolve the fault of a missed delivery. Only staff may override the reason default. */
export function resolveFault(
  reason: NotDeliveredReason,
  actorKind: 'rider' | 'staff' | 'system' | 'customer',
  explicit?: Fault,
): Fault {
  if (actorKind === 'staff' && explicit) return explicit;
  return REASON_FAULT[reason];
}

export interface ValidatedAction {
  ok: boolean;
  error?: string;
}

/** Validate one queued action shape before it can be sent. */
export function validateAction(a: {
  type?: string;
  deliveryId?: string;
  reason?: string;
  hasPhoto?: boolean;
  note?: string;
}): ValidatedAction {
  if (!a.deliveryId) return { ok: false, error: 'deliveryId required' };
  if (a.type === 'delivered') {
    if (!deliveredProofOk(!!a.hasPhoto, a.note)) return { ok: false, error: 'photo or note required' };
    return { ok: true };
  }
  if (a.type === 'not_delivered') {
    if (!a.reason || !(a.reason in REASON_FAULT)) return { ok: false, error: 'valid reason required' };
    return { ok: true };
  }
  return { ok: false, error: 'unknown action type' };
}

export interface QueueRow {
  actionId: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
}

/**
 * Merge a batch into a queue keyed by actionId: a replayed actionId REPLACES the
 * existing row rather than duplicating it (the offline queue is a set, and the
 * server dedupes on actionId anyway). Returns the merged queue sorted by createdAt.
 */
export function mergeQueue(existing: QueueRow[], incoming: QueueRow[]): QueueRow[] {
  const byId = new Map<string, QueueRow>();
  for (const r of existing) byId.set(r.actionId, r);
  for (const r of incoming) byId.set(r.actionId, r);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** Exponential backoff with a 60s ceiling. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
}
