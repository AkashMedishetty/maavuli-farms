/**
 * The rider's day: read today's run, start it, apply outcome actions (idempotent
 * from the offline queue), close it with returns. OWNER: B5 (rider app).
 *
 * The rider app is the only client, so this module shapes the data for the phone:
 * stops grouped by stopKey, per-stop navigation, batched "open next N", progress.
 */

import type { Db, ObjectId } from 'mongodb';
import {
  col,
  REASON_FAULT,
  type Delivery,
  type DeliveryProof,
  type Fault,
  type MilkKind,
  type NotDeliveredReason,
  type RiderRun,
  type StopSnapshot,
} from './models';
import type { OpCtx } from './clock';
import { getDb } from './db';
import { istYMD } from './cutoff';
import { ensureLocked } from './manifest';
import { getOpsSettings } from './settings';
import { assertTransition, RUN_TRANSITIONS } from './transitions';
import { recordEvent } from './events';
import { navigationLinks, stopNavigationUrl } from './maps-links';
import { markDelivered, markNotDelivered } from './outcomes';
import { objectExists } from './storage';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { IllegalTransitionError } from './transitions';

/* --------------------------------------------------------------- read model -- */

export interface RiderStopItem {
  deliveryId: string;
  kind: MilkKind;
  litres: number;
  source: 'plan' | 'makeup' | 'extra';
  status: string;
}

export interface RiderStop {
  stopKey: string;
  seq: number;
  mobile: string;
  name: string;
  address: string;
  landmark?: string;
  instructions?: string;
  location?: { lat: number; lng: number };
  navUrl?: string;
  items: RiderStopItem[];
  /** the aggregate status of the stop: 'pending' until every item is actioned */
  done: boolean;
}

export interface RiderToday {
  date: string;
  hasRun: boolean;
  runId: string | null;
  status: RiderRun['status'] | 'none';
  window: { start: string; end: string };
  stops: RiderStop[];
  /** batched "open next 10 in Google Maps" links, in visiting order (pending stops only) */
  navigationBatches: string[];
  progress: { total: number; done: number };
  load: { cowLitres: number; buffaloLitres: number; stops: number };
  returns?: RiderRun['returns'];
}

function snapshotName(s: StopSnapshot | undefined, fallbackMobile: string): string {
  return s?.name?.trim() || fallbackMobile;
}

/** An item is actioned once its delivery has left the locked/out_for_delivery set. */
function isActioned(status: string): boolean {
  return status !== 'locked' && status !== 'out_for_delivery';
}

function groupStops(deliveries: Delivery[], order: string[]): RiderStop[] {
  const byKey = new Map<string, Delivery[]>();
  for (const d of deliveries) {
    const key = d.stopKey ?? `nokey:${String(d._id)}`;
    const arr = byKey.get(key);
    if (arr) arr.push(d);
    else byKey.set(key, [d]);
  }

  // Visiting order: the run's stopOrder first, then any stop not in it (defensive).
  const orderedKeys = [...order.filter(k => byKey.has(k)), ...[...byKey.keys()].filter(k => !order.includes(k))];

  return orderedKeys.map((key, i) => {
    const group = byKey.get(key)!;
    const first = group[0]!;
    const snap = first.snapshot;
    const items: RiderStopItem[] = group.map(d => ({
      deliveryId: String(d._id),
      kind: d.kind,
      litres: d.litres,
      source: d.source ?? 'plan',
      status: d.status,
    }));
    const done = items.every(it => isActioned(it.status));
    const loc = snap?.location;
    return {
      stopKey: key,
      seq: first.seq ?? i + 1,
      mobile: first.mobile,
      name: snapshotName(snap, first.mobile),
      address: snap?.address ?? '',
      ...(snap?.landmark ? { landmark: snap.landmark } : {}),
      ...(snap?.instructions ? { instructions: snap.instructions } : {}),
      ...(loc ? { location: loc } : {}),
      ...(loc ? { navUrl: safeStopNav(loc) } : {}),
      items,
      done,
    };
  });
}

/** Per-stop nav link — best-effort so B4's stub (or a bad link) does not blank the run. */
function safeStopNav(loc: { lat: number; lng: number }): string | undefined {
  try {
    return stopNavigationUrl(loc);
  } catch {
    return undefined;
  }
}

/** Batched nav links — best-effort for the same reason. */
function safeNavBatches(points: { lat: number; lng: number }[]): string[] {
  if (points.length === 0) return [];
  try {
    return navigationLinks(points);
  } catch {
    return [];
  }
}

/**
 * Today's run for `riderId`. Lazily locks today first (contract §3: a manifest/run
 * read is one of the lazy-lock triggers), then reads this rider's run and stops.
 */
export async function getRiderToday(riderId: ObjectId, ctx: OpCtx): Promise<RiderToday> {
  const db = await getDb();
  const date = istYMD(ctx.now);

  // Lazy lock — best-effort. A lock failure (or B2's stub before it lands) must not
  // blank a rider whose run already exists; reading the run below still works.
  try {
    await ensureLocked(date, ctx);
  } catch {
    /* ignore — the run read below is the source of truth for the rider */
  }

  const settings = await getOpsSettings(db);
  const window = { start: settings.windowStart, end: settings.windowEnd };

  const run = await col.riderRuns(db).findOne({ riderId, date });
  if (!run?._id) {
    return {
      date,
      hasRun: false,
      runId: null,
      status: 'none',
      window,
      stops: [],
      navigationBatches: [],
      progress: { total: 0, done: 0 },
      load: { cowLitres: 0, buffaloLitres: 0, stops: 0 },
    };
  }

  const deliveries = await col
    .deliveries(db)
    .find({ runId: run._id })
    .sort({ seq: 1 })
    .toArray();

  const stops = groupStops(deliveries, run.stopOrder ?? []);
  const pendingStops = stops.filter(s => !s.done && s.location);
  const navigationBatches = safeNavBatches(pendingStops.map(s => s.location!));

  return {
    date,
    hasRun: true,
    runId: String(run._id),
    status: run.status,
    window,
    stops,
    navigationBatches,
    progress: { total: stops.length, done: stops.filter(s => s.done).length },
    load: run.load,
    ...(run.returns ? { returns: run.returns } : {}),
  };
}

/* ---------------------------------------------------------------- run start -- */

/** Move the run to in_progress and its locked rows to out_for_delivery. Idempotent. */
export async function startRun(riderId: ObjectId, ctx: OpCtx): Promise<RiderRun> {
  const db = await getDb();
  const date = istYMD(ctx.now);
  const run = await col.riderRuns(db).findOne({ riderId, date });
  if (!run?._id) throw new NotFoundError('No run assigned to you today.');

  if (run.status === 'in_progress') return run; // idempotent

  assertTransition('rider_run', RUN_TRANSITIONS, run.status, 'in_progress');

  const res = await col.riderRuns(db).updateOne(
    { _id: run._id, status: run.status },
    { $set: { status: 'in_progress', startedAt: ctx.now, updatedAt: ctx.now } },
  );
  if (res.matchedCount === 0) throw new ConflictError('Your run was updated elsewhere — reload.');

  // locked → out_for_delivery for this run's still-locked rows.
  await col.deliveries(db).updateMany(
    { runId: run._id, status: 'locked' },
    { $set: { status: 'out_for_delivery', updatedAt: ctx.now } },
  );

  await recordEvent(
    ctx,
    {
      entity: 'rider_run',
      entityId: String(run._id),
      type: 'rider_run.started',
      from: run.status,
      to: 'in_progress',
      data: { date, stops: run.load.stops },
    },
    db,
  );

  return (await col.riderRuns(db).findOne({ _id: run._id }))!;
}

/* -------------------------------------------------------------- apply actions -- */

export interface RiderActionInput {
  actionId: string; // client UUID — the idempotency key
  type: 'delivered' | 'not_delivered';
  deliveryId: string;
  /** delivered */
  proof?: { photoKey?: string; lat?: number; lng?: number; accuracyM?: number; capturedAt?: string };
  note?: string;
  /** not_delivered */
  reason?: NotDeliveredReason;
  fault?: Fault;
}

export interface RiderActionResult {
  actionId: string;
  ok: boolean;
  status?: string;
  error?: string;
  /** true when this actionId had already been applied (replayed from the offline queue) */
  duplicate?: boolean;
  /** a transient failure: the phone should retry this action later with the same actionId */
  retryable?: boolean;
}

async function ownsDelivery(db: Db, riderId: ObjectId, deliveryId: ObjectId): Promise<Delivery | null> {
  const d = await col.deliveries(db).findOne({ _id: deliveryId, riderId });
  return d ?? null;
}

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * The phone's input is untrusted: every field is type-checked and bounded before it
 * reaches the database. Returns a clean action or the reason it was refused.
 * (Objects where strings are expected would otherwise become Mongo operators, and
 * `reason in REASON_FAULT` would accept prototype keys like "constructor".)
 */
export function sanitizeAction(raw: unknown): { ok: true; action: RiderActionInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'action must be an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.actionId !== 'string' || r.actionId.length < 8 || r.actionId.length > 100) {
    return { ok: false, error: 'actionId must be a string of 8–100 characters' };
  }
  if (r.type !== 'delivered' && r.type !== 'not_delivered') return { ok: false, error: 'unknown action type' };
  if (typeof r.deliveryId !== 'string' || !OBJECT_ID_RE.test(r.deliveryId)) return { ok: false, error: 'invalid deliveryId' };
  if (r.note !== undefined && typeof r.note !== 'string') return { ok: false, error: 'note must be text' };
  const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, 500) : undefined;
  const out: RiderActionInput = { actionId: r.actionId, type: r.type, deliveryId: r.deliveryId, ...(note ? { note } : {}) };

  if (r.type === 'not_delivered') {
    if (typeof r.reason !== 'string' || !Object.hasOwn(REASON_FAULT, r.reason)) return { ok: false, error: 'a valid reason is required' };
    out.reason = r.reason as NotDeliveredReason;
    return { ok: true, action: out };
  }

  if (r.proof !== undefined) {
    if (!r.proof || typeof r.proof !== 'object' || Array.isArray(r.proof)) return { ok: false, error: 'proof must be an object' };
    const p = r.proof as Record<string, unknown>;
    const proof: NonNullable<RiderActionInput['proof']> = {};
    if (p.photoKey !== undefined) {
      if (typeof p.photoKey !== 'string' || p.photoKey.length > 200 || !p.photoKey.startsWith('photos/')) {
        return { ok: false, error: 'invalid photoKey' };
      }
      proof.photoKey = p.photoKey;
    }
    if (p.lat !== undefined || p.lng !== undefined) {
      if (!finite(p.lat, -90, 90) || !finite(p.lng, -180, 180)) return { ok: false, error: 'invalid GPS position' };
      proof.lat = p.lat;
      proof.lng = p.lng;
    }
    if (p.accuracyM !== undefined && finite(p.accuracyM, 0, 100_000)) proof.accuracyM = p.accuracyM;
    if (typeof p.capturedAt === 'string' && Number.isFinite(Date.parse(p.capturedAt))) proof.capturedAt = p.capturedAt;
    out.proof = proof;
  }
  return { ok: true, action: out };
}

/**
 * Apply a batch of outcome actions from the phone. Every action carries a client
 * UUID; a replay of the same actionId is a no-op that reports the prior result, so
 * the offline queue can retry safely. Actions are independent — one failing does
 * not fail the batch.
 *
 * A rider may only act on TODAY's stops (of their own run, open or closed). Past days —
 * are corrected by ops in the admin console, never
 * from the phone: otherwise a rider could flip an old delivery to "not delivered,
 * our fault" and mint compensation for it, or strip a customer's make-up day.
 */
export async function applyActions(
  riderId: ObjectId,
  rawActions: unknown[],
  ctx: OpCtx,
): Promise<RiderActionResult[]> {
  if (rawActions.length > 50) throw new ValidationError('Too many actions in one batch (max 50).');
  const db = await getDb();
  const { ObjectId } = await import('mongodb');
  const results: RiderActionResult[] = [];
  const today = istYMD(ctx.now);

  for (const raw of rawActions) {
    const clean = sanitizeAction(raw);
    if (!clean.ok) {
      const id = raw && typeof raw === 'object' && typeof (raw as { actionId?: unknown }).actionId === 'string'
        ? ((raw as { actionId: string }).actionId).slice(0, 100)
        : 'invalid';
      results.push({ actionId: id, ok: false, error: clean.error });
      continue;
    }
    const a = clean.action;

    // Idempotency: a seen actionId short-circuits with its recorded result.
    const seen = await col.riderActions(db).findOne({ actionId: a.actionId, riderId });
    if (seen) {
      results.push({
        actionId: a.actionId,
        ok: seen.result === 'applied',
        duplicate: true,
        ...(seen.error ? { error: seen.error } : {}),
      });
      continue;
    }

    const deliveryId = new ObjectId(a.deliveryId);
    const owned = await ownsDelivery(db, riderId, deliveryId);
    if (!owned) {
      await recordAction(db, riderId, a, 'rejected', 'not your delivery', ctx);
      results.push({ actionId: a.actionId, ok: false, error: 'not your delivery' });
      continue;
    }

    // Same day only. The run's status does NOT matter: a phone that was offline syncs
    // its queue after the rider pressed Close, or after the 10:00 day close marked the
    // stop unconfirmed — that is the rider's own evidence for today and must land,
    // or delivered milk turns into "our miss" and is compensated.
    const run = owned.runId ? await col.riderRuns(db).findOne({ _id: owned.runId, riderId }) : null;
    if (owned.date !== today || !run) {
      const error = 'Only today’s stops can be changed from the app. Ask ops to correct an earlier day.';
      await recordAction(db, riderId, a, 'rejected', error, ctx, deliveryId);
      results.push({ actionId: a.actionId, ok: false, error });
      continue;
    }

    try {
      let updated: Delivery;
      if (a.type === 'delivered') {
        // The photo must be one uploaded for THIS delivery — a rider cannot prove one
        // doorstep with another doorstep's picture — and its bytes must really exist
        // (a blob upload is indexed when the phone asks for a token, before it uploads).
        if (a.proof?.photoKey) {
          const photo = await col.photos(db).findOne({ key: a.proof.photoKey, deliveryId, riderId });
          if (!photo) throw new ValidationError('That photo was not uploaded for this delivery.');
          if (!(await objectExists(a.proof.photoKey))) {
            // transient, so NOT a permanent rejection: the phone retries this action
            throw new ConflictError('The photo has not finished uploading. Try again in a moment.');
          }
        }
        const proof: DeliveryProof = {
          ...(a.proof?.photoKey ? { photoKey: a.proof.photoKey } : {}),
          ...(typeof a.proof?.lat === 'number' ? { lat: a.proof.lat } : {}),
          ...(typeof a.proof?.lng === 'number' ? { lng: a.proof.lng } : {}),
          ...(typeof a.proof?.accuracyM === 'number' ? { accuracyM: a.proof.accuracyM } : {}),
          ...(a.proof?.capturedAt ? { capturedAt: new Date(a.proof.capturedAt) } : {}),
        };
        // A no-camera delivery must carry a note; markDelivered stores it in the same
        // conditional update as the status change (never ahead of it).
        updated = await markDelivered(deliveryId, proof, ctx, a.note ? { note: a.note } : {});
      } else if (a.type === 'not_delivered') {
        if (!a.reason) throw new ValidationError('reason required for not_delivered');
        updated = await markNotDelivered(
          deliveryId,
          { reason: a.reason, ...(a.note ? { note: a.note } : {}), ...(a.fault ? { fault: a.fault } : {}) },
          ctx,
        );
      } else {
        throw new ValidationError(`unknown action type "${String(a.type)}"`);
      }
      await recordAction(db, riderId, a, 'applied', undefined, ctx, deliveryId);
      results.push({ actionId: a.actionId, ok: true, status: updated.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed';
      // Only a PERMANENT rejection is remembered against the actionId. A transient
      // failure (a DB blip, a concurrent update) is not recorded, so the phone's
      // retry with the same actionId is applied instead of being answered with the
      // stored failure forever.
      const permanent =
        err instanceof ValidationError || err instanceof NotFoundError || err instanceof IllegalTransitionError;
      if (permanent) await recordAction(db, riderId, a, 'rejected', msg, ctx, deliveryId);
      results.push({ actionId: a.actionId, ok: false, error: msg, ...(permanent ? {} : { retryable: true }) });
    }
  }

  return results;
}

async function recordAction(
  db: Db,
  riderId: ObjectId,
  a: RiderActionInput,
  result: 'applied' | 'rejected',
  error: string | undefined,
  ctx: OpCtx,
  deliveryId?: ObjectId,
): Promise<void> {
  try {
    await col.riderActions(db).insertOne({
      actionId: a.actionId,
      riderId,
      ...(deliveryId ? { deliveryId } : {}),
      type: a.type,
      receivedAt: ctx.now,
      result,
      ...(error ? { error } : {}),
    });
  } catch {
    // A duplicate-key race means another writer recorded the same actionId first —
    // the outcome write is itself idempotent, so this is safe to ignore.
  }
}

/* --------------------------------------------------------------- close run -- */

export interface CloseRunReturns {
  cowLitres?: number;
  buffaloLitres?: number;
  note?: string;
}

/** Close the run and record leftover stock returned to the farm. */
export async function closeRun(riderId: ObjectId, returns: CloseRunReturns, ctx: OpCtx): Promise<RiderRun> {
  const db = await getDb();
  const date = istYMD(ctx.now);
  const run = await col.riderRuns(db).findOne({ riderId, date });
  if (!run?._id) throw new NotFoundError('No run assigned to you today.');

  if (run.status === 'closed') return run; // idempotent

  for (const v of [returns.cowLitres, returns.buffaloLitres]) {
    if (v !== undefined && (typeof v !== 'number' || v < 0 || !Number.isFinite(v))) {
      throw new ValidationError('Returned litres must be zero or a positive number.');
    }
  }

  assertTransition('rider_run', RUN_TRANSITIONS, run.status, 'closed');

  const cleaned: CloseRunReturns = {
    ...(typeof returns.cowLitres === 'number' ? { cowLitres: returns.cowLitres } : {}),
    ...(typeof returns.buffaloLitres === 'number' ? { buffaloLitres: returns.buffaloLitres } : {}),
    ...(returns.note ? { note: returns.note.slice(0, 500) } : {}),
  };

  const res = await col.riderRuns(db).updateOne(
    { _id: run._id, status: run.status },
    { $set: { status: 'closed', closedAt: ctx.now, updatedAt: ctx.now, returns: cleaned } },
  );
  if (res.matchedCount === 0) throw new ConflictError('Your run was updated elsewhere — reload.');

  await recordEvent(
    ctx,
    {
      entity: 'rider_run',
      entityId: String(run._id),
      type: 'rider_run.closed',
      from: run.status,
      to: 'closed',
      data: { returns: cleaned },
    },
    db,
  );

  return (await col.riderRuns(db).findOne({ _id: run._id }))!;
}
