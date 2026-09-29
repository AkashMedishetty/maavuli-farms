/**
 * The day engine: lock (freeze tomorrow's manifest), close (unmarked → unconfirmed),
 * auto-resolution of stale unconfirmed deliveries, cover riders.
 *
 * OWNER: B2 (day engine). Keep the signatures; replace the bodies.
 */

import type { ObjectId } from 'mongodb';
import type { DayLock, RiderRun } from './models';
import type { OpCtx } from './clock';

/**
 * Freeze `date`: every planned delivery → locked, stamped with rider, run, seq,
 * stopKey and a StopSnapshot; one RiderRun per rider (null = unassigned bucket);
 * a day_locks doc. Idempotent — re-locking a locked day returns the existing lock
 * (and picks up planned rows added since, e.g. by ops, into the runs).
 */
export async function lockDay(date: string, ctx: OpCtx): Promise<DayLock> {
  void date;
  void ctx;
  throw new Error('not implemented: lockDay (owner B2)');
}

/** Lock `date` if it is past its cutoff and not locked yet. Returns the lock, or null when not due. */
export async function ensureLocked(date: string, ctx: OpCtx): Promise<DayLock | null> {
  void date;
  void ctx;
  throw new Error('not implemented: ensureLocked (owner B2)');
}

/** Tick step. */
export async function lockDueDays(ctx: OpCtx): Promise<{ locked: string[] }> {
  void ctx;
  throw new Error('not implemented: lockDueDays (owner B2)');
}

/** locked | out_for_delivery → unconfirmed for `date` (after its dayCloseTime). Also completes/ closes runs. */
export async function closeDay(date: string, ctx: OpCtx): Promise<{ unconfirmed: number }> {
  void date;
  void ctx;
  throw new Error('not implemented: closeDay (owner B2)');
}

/** Tick step. */
export async function closeDueDays(ctx: OpCtx): Promise<{ closed: string[]; unconfirmed: number }> {
  void ctx;
  throw new Error('not implemented: closeDueDays (owner B2)');
}

/**
 * Tick step: an unconfirmed delivery still unresolved 24 h after its day closed
 * becomes not_delivered (reason 'other', fault 'ours') and is compensated — the
 * customer never pays for a tap the rider did not make.
 */
export async function autoResolveStaleUnconfirmed(ctx: OpCtx): Promise<{ resolved: number }> {
  void ctx;
  throw new Error('not implemented: autoResolveStaleUnconfirmed (owner B2)');
}

/** Hand a run to a cover rider for the day (moves its deliveries' riderId too). */
export async function reassignRun(runId: ObjectId, riderId: ObjectId, ctx: OpCtx): Promise<RiderRun> {
  void runId;
  void riderId;
  void ctx;
  throw new Error('not implemented: reassignRun (owner B2)');
}

export interface ManifestStop {
  stopKey: string;
  seq: number;
  mobile: string;
  snapshot: {
    name: string;
    address: string;
    landmark?: string;
    instructions?: string;
    location?: { lat: number; lng: number };
    zoneName?: string;
  };
  items: { deliveryId: string; kind: 'cow' | 'buffalo'; litres: number; source: 'plan' | 'makeup' | 'extra'; status: string }[];
}

export interface ManifestRun {
  runId: string | null;
  riderId: string | null;
  riderName: string;
  status: string;
  load: { cowLitres: number; buffaloLitres: number; stops: number };
  stops: ManifestStop[];
}

export interface Manifest {
  date: string;
  locked: boolean;
  lockAt: string;
  runs: ManifestRun[];
  totals: { cowLitres: number; buffaloLitres: number; stops: number; deliveries: number };
}

/** The day's manifest — frozen runs when locked, a live preview (same shape) when not. */
export async function getManifest(date: string, ctx: OpCtx): Promise<Manifest> {
  void date;
  void ctx;
  throw new Error('not implemented: getManifest (owner B2)');
}
