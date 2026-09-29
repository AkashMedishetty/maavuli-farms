/**
 * The day engine: lock (freeze a date's manifest at the cutoff), close (unmarked →
 * unconfirmed after the day-close time), auto-resolve of stale unconfirmed
 * deliveries, cover riders, and the manifest read model.
 *
 * Lock is the moment a date stops being "the customer's" and becomes "the farm's":
 * every planned delivery is stamped with who runs it (the zone's rider, or the
 * unassigned bucket), which run, its position in that run, its stop identity and a
 * frozen snapshot of name/address/pin — so a customer's later address edit can never
 * move a stop that is already on a rider's phone. One RiderRun per rider per date.
 *
 * Every function here is idempotent and safe to call from the 5-minute tick, from a
 * page read (lazy lock), and concurrently: each row moves with a conditional update
 * that matches its FROM status, and runs/locks are upserts on unique keys.
 */

import { ObjectId, type AnyBulkWriteOperation, type Db } from 'mongodb';
import { getDb } from './db';
import {
  col,
  stopKeyOf,
  type DayLock,
  type Delivery,
  type LatLng,
  type MilkKind,
  type RiderRun,
  type StopSnapshot,
  type Subscription,
  type Zone,
} from './models';
import type { OpCtx } from './clock';
import { recordEvent } from './events';
import { dayRulesOf, getOpsSettings } from './settings';
import { addDaysYMD, closeInstant, hmLabel, isPastCutoff, istInstant, istYMD, lockInstant } from './cutoff';
import { orderStopsForRider, type StopInput } from './route-plan';
import { markNotDelivered } from './outcomes';
import { enqueueMessage } from './notify';
import { assertTransition, RUN_TRANSITIONS } from './transitions';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { pointInPolygon } from './geo';

/** Rows that still belong to the customer (not yet frozen). 'scheduled' is legacy. */
const OPEN_STATUSES = ['planned', 'scheduled'] as const;
/** Rows a rider is (or should be) acting on. */
const LIVE_STATUSES = ['locked', 'out_for_delivery'] as const;
/** How far back the tick looks for days that never locked/closed (an outage). */
const LOOKBACK_DAYS = 7;
const MS_PER_HOUR = 3_600_000;

/* ------------------------------------------------------------ helpers ---- */

function riderKey(id: ObjectId | null | undefined): string {
  return id ? id.toHexString() : 'unassigned';
}

/** Human date for messages: "Thu 2 Oct". */
export function dateLabel(ymd: string): string {
  return istInstant(ymd, '12:00').toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function zoneFor(sub: Subscription | undefined, zones: Zone[], byId: Map<string, Zone>): Zone | undefined {
  if (!sub) return undefined;
  if (sub.zoneId) {
    const z = byId.get(sub.zoneId.toHexString());
    if (z) return z;
  }
  const loc = sub.location;
  if (!loc) return undefined;
  // Legacy rows without a cached zone: planar point-in-polygon over the active zones
  // (city-sized areas — see lib/geo), first match by name for determinism.
  return zones.find(z => pointInPolygon(loc, z.geometry));
}

function snapshotOf(row: Delivery, sub: Subscription | undefined, zone: Zone | undefined): StopSnapshot {
  const loc = sub?.location ? { lat: sub.location.lat, lng: sub.location.lng } : undefined;
  return {
    name: sub?.name?.trim() || row.mobile,
    address: sub?.address?.trim() || `Pincode ${row.pincode}`,
    ...(sub?.landmark ? { landmark: sub.landmark } : {}),
    ...(sub?.instructions ? { instructions: sub.instructions } : {}),
    ...(loc ? { location: loc } : {}),
    ...(zone?._id ? { zoneId: zone._id } : {}),
    ...(zone?.name ? { zoneName: zone.name } : {}),
  };
}

function stopKeyFor(row: Delivery, sub: Subscription | undefined): string {
  if (row.stopKey) return row.stopKey;
  if (sub?.stopKey) return sub.stopKey;
  if (sub?.location) return stopKeyOf(row.mobile, sub.location);
  // No pin: one stop per customer per pincode, routed by hand.
  return `${row.mobile}@pin:${row.pincode}`;
}

interface PlannedRow {
  row: Delivery;
  sub: Subscription | undefined;
  zone: Zone | undefined;
  riderId: ObjectId | null;
  stopKey: string;
  snapshot: StopSnapshot;
}

/** Load the rows for `date` in `statuses` with their subscription + zone resolved. */
async function resolveRows(db: Db, date: string, statuses: readonly string[]): Promise<PlannedRow[]> {
  const rows = await col
    .deliveries(db)
    .find({ date, status: { $in: [...statuses] as Delivery['status'][] } })
    .sort({ mobile: 1, _id: 1 })
    .toArray();
  if (rows.length === 0) return [];

  const subIds = [...new Set(rows.map(r => r.subscriptionId.toHexString()))].map(id => new ObjectId(id));
  const subs = await col.subscriptions(db).find({ _id: { $in: subIds } }).toArray();
  const subById = new Map(subs.map(s => [s._id!.toHexString(), s]));
  const zones = await col.zones(db).find({ active: true }).sort({ name: 1 }).toArray();
  const zoneById = new Map(zones.map(z => [z._id!.toHexString(), z]));

  return rows.map(row => {
    const sub = subById.get(row.subscriptionId.toHexString());
    const zone = zoneFor(sub, zones, zoneById);
    return {
      row,
      sub,
      zone,
      riderId: zone?.riderId ?? null,
      stopKey: stopKeyFor(row, sub),
      snapshot: snapshotOf(row, sub, zone),
    };
  });
}

function loadOf(rows: Pick<Delivery, 'kind' | 'litres' | 'stopKey'>[]): RiderRun['load'] {
  let cowLitres = 0;
  let buffaloLitres = 0;
  const stops = new Set<string>();
  for (const r of rows) {
    if (r.kind === 'cow') cowLitres += r.litres;
    else buffaloLitres += r.litres;
    if (r.stopKey) stops.add(r.stopKey);
  }
  return { cowLitres: round2(cowLitres), buffaloLitres: round2(buffaloLitres), stops: stops.size };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Order one rider's stops: pinned stops by the standing route, pinless ones after, by key. */
async function orderForRider(
  riderId: ObjectId | null,
  stops: Map<string, StopSnapshot>,
  ctx: OpCtx,
  markDirty: boolean,
): Promise<{ order: string[]; source: RiderRun['routeSource']; totalM?: number }> {
  const pinned: StopInput[] = [];
  const pinless: string[] = [];
  for (const [key, snap] of stops) {
    if (snap.location) pinned.push({ stopKey: key, location: snap.location });
    else pinless.push(key);
  }
  const ordered = await orderStopsForRider(riderId, pinned, ctx, { markDirty });
  return {
    order: [...ordered.order, ...pinless.sort()],
    source: ordered.source,
    ...(ordered.totalM !== undefined ? { totalM: ordered.totalM } : {}),
  };
}

/* ---------------------------------------------------------------- lock ---- */

/**
 * Freeze `date`. Idempotent: re-locking picks up planned rows added since (ops, or
 * a crash half-way through a previous lock) into the existing runs. A run the rider
 * has not started is re-sequenced in full; a started run gets new stops appended.
 */
export async function lockDay(date: string, ctx: OpCtx): Promise<DayLock> {
  const db = await getDb();
  const planned = await resolveRows(db, date, OPEN_STATUSES);

  // group: rider → stopKey → snapshot (first row wins; cow+buffalo at one door share it)
  const byRider = new Map<string, { riderId: ObjectId | null; rows: PlannedRow[]; stops: Map<string, StopSnapshot> }>();
  for (const p of planned) {
    const k = riderKey(p.riderId);
    let g = byRider.get(k);
    if (!g) {
      g = { riderId: p.riderId, rows: [], stops: new Map() };
      byRider.set(k, g);
    }
    g.rows.push(p);
    if (!g.stops.has(p.stopKey)) g.stops.set(p.stopKey, p.snapshot);
  }

  let lockedRows = 0;
  for (const g of byRider.values()) {
    const existing = await col.riderRuns(db).findOne({ riderId: g.riderId, date });
    let runId: ObjectId;
    let stopOrder: string[];

    if (!existing) {
      const ordered = await orderForRider(g.riderId, g.stops, ctx, true);
      stopOrder = ordered.order;
      const doc: Omit<RiderRun, '_id'> = {
        date,
        riderId: g.riderId,
        status: 'planned',
        stopOrder,
        deliveryIds: [],
        load: { cowLitres: 0, buffaloLitres: 0, stops: 0 },
        routeSource: ordered.source,
        ...(ordered.totalM !== undefined ? { totalM: ordered.totalM } : {}),
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      // upsert on the unique {riderId,date}: a concurrent lock creates it only once
      const up = await upsertRun(db, g.riderId, date, doc);
      runId = up._id!;
      stopOrder = up.stopOrder;
    } else {
      runId = existing._id!;
      const known = new Set(existing.stopOrder);
      const newKeys = [...g.stops.keys()].filter(k => !known.has(k));
      if (existing.status === 'planned' && newKeys.length > 0) {
        // not started: re-sequence everything (existing + new) from the standing route
        const all = new Map<string, StopSnapshot>();
        const liveRows = await col.deliveries(db).find({ runId }).toArray();
        for (const r of liveRows) if (r.stopKey && r.snapshot) all.set(r.stopKey, r.snapshot);
        for (const [k, s] of g.stops) if (!all.has(k)) all.set(k, s);
        stopOrder = (await orderForRider(g.riderId, all, ctx, true)).order;
      } else {
        // started (or nothing new): append, never reshuffle a run in progress
        stopOrder = [...existing.stopOrder, ...newKeys];
      }
      if (newKeys.length > 0) {
        await col.riderRuns(db).updateOne({ _id: runId }, { $set: { stopOrder, updatedAt: ctx.now } });
      }
    }

    const seqOf = new Map(stopOrder.map((k, i) => [k, i + 1]));
    const ops: AnyBulkWriteOperation<Delivery>[] = g.rows.map(p => ({
      updateOne: {
        filter: { _id: p.row._id!, status: p.row.status },
        update: {
          $set: {
            status: 'locked',
            lockedAt: ctx.now,
            riderId: g.riderId,
            runId,
            seq: seqOf.get(p.stopKey) ?? stopOrder.length + 1,
            stopKey: p.stopKey,
            snapshot: p.snapshot,
            updatedAt: ctx.now,
          },
        },
      },
    }));
    if (ops.length) {
      const res = await col.deliveries(db).bulkWrite(ops, { ordered: false });
      lockedRows += res.modifiedCount;
    }

    // keep every row's seq consistent with the (possibly re-sequenced) stop order
    await resequence(db, runId, stopOrder);
    await refreshRunTotals(db, runId, ctx);
  }

  // The day's lock document (counts refreshed on every re-lock).
  const all = await col
    .deliveries(db)
    .find({ date, runId: { $exists: true } })
    .project<Pick<Delivery, 'kind' | 'litres' | 'stopKey'>>({ kind: 1, litres: 1, stopKey: 1 })
    .toArray();
  const totals = loadOf(all);
  const lockRes = await col.dayLocks(db).findOneAndUpdate(
    { _id: date },
    {
      $setOnInsert: { lockedAt: ctx.now, lockedBy: ctx.actor },
      $set: { stops: totals.stops, cowLitres: totals.cowLitres, buffaloLitres: totals.buffaloLitres },
    },
    { upsert: true, returnDocument: 'after', includeResultMetadata: true },
  );
  const lock = lockRes.value!;
  const createdNow = lockRes.lastErrorObject?.updatedExisting === false;

  if (createdNow || lockedRows > 0) {
    await recordEvent(
      ctx,
      {
        entity: 'day',
        entityId: date,
        type: createdNow ? 'day.locked' : 'day.relocked',
        data: { deliveries: lockedRows, stops: totals.stops, cowLitres: totals.cowLitres, buffaloLitres: totals.buffaloLitres, runs: byRider.size },
      },
      db,
    );
  }

  // First-delivery notices: plans whose first delivery is this date, with a row on it.
  if (lockedRows > 0) await notifyFirstDeliveries(db, date, ctx);

  return lock;
}

/**
 * Create the run for (rider, date) once. Two concurrent upserts on the unique
 * {riderId,date} index can race to insert; the loser gets E11000 and simply reads
 * the winner's document.
 */
async function upsertRun(db: Db, riderId: ObjectId | null, date: string, doc: Omit<RiderRun, '_id'>): Promise<RiderRun> {
  try {
    const up = await col.riderRuns(db).findOneAndUpdate(
      { riderId, date },
      { $setOnInsert: doc },
      { upsert: true, returnDocument: 'after' },
    );
    if (up) return up;
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  const again = await col.riderRuns(db).findOne({ riderId, date });
  if (!again) throw new ConflictError('Could not create the rider run — try again.');
  return again;
}

async function resequence(db: Db, runId: ObjectId, stopOrder: string[]): Promise<void> {
  const seqOf = new Map(stopOrder.map((k, i) => [k, i + 1]));
  const rows = await col.deliveries(db).find({ runId }).project<{ _id: ObjectId; stopKey?: string; seq?: number }>({ stopKey: 1, seq: 1 }).toArray();
  const ops: AnyBulkWriteOperation<Delivery>[] = [];
  for (const r of rows) {
    const want = r.stopKey ? seqOf.get(r.stopKey) : undefined;
    if (want !== undefined && want !== r.seq) ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: { seq: want } } } });
  }
  if (ops.length) await col.deliveries(db).bulkWrite(ops, { ordered: false });
}

async function refreshRunTotals(db: Db, runId: ObjectId, ctx: OpCtx): Promise<void> {
  const rows = await col
    .deliveries(db)
    .find({ runId })
    .project<Pick<Delivery, '_id' | 'kind' | 'litres' | 'stopKey'>>({ kind: 1, litres: 1, stopKey: 1 })
    .toArray();
  await col.riderRuns(db).updateOne(
    { _id: runId },
    { $set: { load: loadOf(rows), deliveryIds: rows.map(r => r._id!), updatedAt: ctx.now } },
  );
}

async function notifyFirstDeliveries(db: Db, date: string, ctx: OpCtx): Promise<void> {
  const settings = await getOpsSettings(db);
  const window = `${hmLabel(settings.windowStart)}–${hmLabel(settings.windowEnd)}`;
  // renewals continue an existing round, so "your first delivery is tomorrow" would
  // only confuse — they are skipped
  const subs = await col
    .subscriptions(db)
    .find({ startDate: date, status: { $in: ['scheduled', 'active'] }, renewalOf: { $exists: false } })
    .project<{ _id: ObjectId; mobile: string }>({ mobile: 1 })
    .toArray();
  for (const s of subs) {
    const has = await col.deliveries(db).countDocuments({ subscriptionId: s._id, date, status: 'locked' }, { limit: 1 });
    if (!has) continue;
    await enqueueMessage(
      {
        mobile: s.mobile,
        template: 'first_delivery_tomorrow',
        params: { date: dateLabel(date), window },
        dedupeKey: `first_delivery:${s._id.toHexString()}`,
      },
      ctx,
    );
  }
}

/**
 * Lock `date` if it is past its cutoff and not (fully) locked yet. Returns the lock,
 * or null when the date is still open and nobody locked it early.
 */
export async function ensureLocked(date: string, ctx: OpCtx): Promise<DayLock | null> {
  const db = await getDb();
  const rules = dayRulesOf(await getOpsSettings(db));
  const lock = await col.dayLocks(db).findOne({ _id: date });
  const due = isPastCutoff(date, ctx.now, rules);
  if (!due && !lock) return null;
  const pending = await col.deliveries(db).countDocuments({ date, status: { $in: [...OPEN_STATUSES] } }, { limit: 1 });
  if (pending === 0) return lock; // nothing to freeze (an empty day never gets a lock)
  return lockDay(date, ctx);
}

/** Tick step: lock every date that is past its cutoff (today, tomorrow, and a lookback for outages). */
export async function lockDueDays(ctx: OpCtx): Promise<{ locked: string[] }> {
  const db = await getDb();
  const today = istYMD(ctx.now);
  const locked: string[] = [];
  for (let i = -LOOKBACK_DAYS; i <= 1; i++) {
    const date = addDaysYMD(today, i);
    const pending = await col.deliveries(db).countDocuments({ date, status: { $in: [...OPEN_STATUSES] } }, { limit: 1 });
    if (!pending) continue;
    const res = await ensureLocked(date, ctx);
    if (res) locked.push(date);
  }
  return { locked };
}

/** Manually lock today or tomorrow ahead of the cutoff (ops). */
export async function lockDayEarly(date: string, ctx: OpCtx): Promise<DayLock> {
  const today = istYMD(ctx.now);
  if (date !== today && date !== addDaysYMD(today, 1)) {
    throw new ValidationError('Only today or tomorrow can be locked by hand.');
  }
  return lockDay(date, ctx);
}

/* --------------------------------------------------------------- close ---- */

/**
 * Close `date` (after its dayCloseTime): anything still locked or out for delivery
 * becomes 'unconfirmed' for ops to resolve, and every run is closed. Idempotent.
 */
export async function closeDay(date: string, ctx: OpCtx): Promise<{ unconfirmed: number }> {
  const db = await getDb();
  const rules = dayRulesOf(await getOpsSettings(db));
  if (ctx.now.getTime() < closeInstant(date, rules).getTime()) {
    throw new ConflictError(`${date} cannot close before ${rules.dayCloseTime}.`);
  }

  // A day that never locked (an outage) is locked first, so its rows get a rider and
  // a snapshot before they are marked unconfirmed.
  await ensureLocked(date, ctx);

  const res = await col.deliveries(db).updateMany(
    { date, status: { $in: [...LIVE_STATUSES] } },
    { $set: { status: 'unconfirmed', updatedAt: ctx.now } },
  );
  const unconfirmed = res.modifiedCount;

  const runs = await col.riderRuns(db).find({ date, status: { $ne: 'closed' } }).toArray();
  for (const run of runs) {
    assertTransition('rider_run', RUN_TRANSITIONS, run.status, 'closed');
    await col.riderRuns(db).updateOne(
      { _id: run._id!, status: run.status },
      { $set: { status: 'closed', closedAt: ctx.now, updatedAt: ctx.now } },
    );
  }

  const lock = await col.dayLocks(db).findOneAndUpdate(
    { _id: date, closedAt: { $exists: false } },
    { $set: { closedAt: ctx.now, unconfirmedAtClose: unconfirmed } },
    { returnDocument: 'after' },
  );
  if (lock || unconfirmed > 0) {
    await recordEvent(ctx, { entity: 'day', entityId: date, type: 'day.closed', data: { unconfirmed, runs: runs.length } }, db);
  }
  return { unconfirmed };
}

/** Tick step: close every recent date whose close time has passed and is not closed yet. */
export async function closeDueDays(ctx: OpCtx): Promise<{ closed: string[]; unconfirmed: number }> {
  const db = await getDb();
  const rules = dayRulesOf(await getOpsSettings(db));
  const today = istYMD(ctx.now);
  const closed: string[] = [];
  let unconfirmed = 0;
  for (let i = -LOOKBACK_DAYS; i <= 0; i++) {
    const date = addDaysYMD(today, i);
    if (ctx.now.getTime() < closeInstant(date, rules).getTime()) continue;
    const lock = await col.dayLocks(db).findOne({ _id: date });
    const open = await col.deliveries(db).countDocuments(
      { date, status: { $in: [...OPEN_STATUSES, ...LIVE_STATUSES] } },
      { limit: 1 },
    );
    if (!open && (!lock || lock.closedAt)) continue;
    const r = await closeDay(date, ctx);
    closed.push(date);
    unconfirmed += r.unconfirmed;
  }
  return { closed, unconfirmed };
}

/**
 * Tick step: an unconfirmed delivery still unresolved 24 h after its day closed
 * becomes not_delivered (reason 'other', fault 'ours') and is compensated — the
 * customer never pays for a tap the rider did not make.
 */
export async function autoResolveStaleUnconfirmed(ctx: OpCtx): Promise<{ resolved: number }> {
  const db = await getDb();
  const rules = dayRulesOf(await getOpsSettings(db));
  const dates = (await col.deliveries(db).distinct('date', { status: 'unconfirmed' })) as string[];
  let resolved = 0;
  for (const date of dates) {
    const staleAt = closeInstant(date, rules).getTime() + 24 * MS_PER_HOUR;
    if (ctx.now.getTime() < staleAt) continue;
    const rows = await col.deliveries(db).find({ date, status: 'unconfirmed' }).project<{ _id: ObjectId }>({ _id: 1 }).toArray();
    for (const r of rows) {
      try {
        await markNotDelivered(
          r._id,
          {
            reason: 'other',
            fault: 'ours',
            note: 'Not confirmed within 24 hours of the day closing — treated as our miss.',
          },
          ctx,
        );
        resolved++;
      } catch (err) {
        // a concurrent resolution by ops is fine; anything else is retried next tick
        // eslint-disable-next-line no-console
        console.error('[manifest] auto-resolve failed', r._id.toHexString(), err instanceof Error ? err.message : err);
      }
    }
  }
  return { resolved };
}

/* ---------------------------------------------------------- cover rider ---- */

/** Hand a run to a cover rider for the day (moves its deliveries' riderId too). */
export async function reassignRun(runId: ObjectId, riderId: ObjectId, ctx: OpCtx): Promise<RiderRun> {
  const db = await getDb();
  const run = await col.riderRuns(db).findOne({ _id: runId });
  if (!run) throw new NotFoundError('Run not found');
  if (run.status === 'closed') throw new ConflictError('This run is already closed.');
  const rider = await col.riders(db).findOne({ _id: riderId, active: true });
  if (!rider) throw new NotFoundError('Rider not found or inactive');
  if (run.riderId && run.riderId.equals(riderId)) return run;

  // A rider can hold one run per date (unique index): refuse rather than merge two
  // runs silently — ops can reassign the other run first.
  const clash = await col.riderRuns(db).findOne({ riderId, date: run.date });
  if (clash) throw new ConflictError(`${rider.name} already has a run on ${run.date}. Reassign or merge that one first.`);

  const res = await col.riderRuns(db).findOneAndUpdate(
    { _id: runId, riderId: run.riderId },
    {
      $set: {
        riderId,
        updatedAt: ctx.now,
        // remember whose territory it was (first reassignment only)
        ...(run.territoryRiderId === undefined ? { territoryRiderId: run.riderId } : {}),
      },
    },
    { returnDocument: 'after' },
  );
  if (!res) throw new ConflictError('The run changed while reassigning — reload and try again.');
  await col.deliveries(db).updateMany({ runId }, { $set: { riderId, updatedAt: ctx.now } });
  await recordEvent(
    ctx,
    {
      entity: 'rider_run',
      entityId: runId.toHexString(),
      type: 'rider_run.reassigned',
      from: riderKey(run.riderId),
      to: riderId.toHexString(),
      data: { date: run.date },
    },
    db,
  );
  return res;
}

/* ------------------------------------------------------------- manifest ---- */

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

function toManifestStops(rows: { stopKey: string; seq: number; mobile: string; snapshot: StopSnapshot; row: Pick<Delivery, '_id' | 'kind' | 'litres' | 'source' | 'status'> }[]): ManifestStop[] {
  const byKey = new Map<string, ManifestStop>();
  for (const r of rows) {
    let s = byKey.get(r.stopKey);
    if (!s) {
      const snap = r.snapshot;
      s = {
        stopKey: r.stopKey,
        seq: r.seq,
        mobile: r.mobile,
        snapshot: {
          name: snap.name,
          address: snap.address,
          ...(snap.landmark ? { landmark: snap.landmark } : {}),
          ...(snap.instructions ? { instructions: snap.instructions } : {}),
          ...(snap.location ? { location: snap.location } : {}),
          ...(snap.zoneName ? { zoneName: snap.zoneName } : {}),
        },
        items: [],
      };
      byKey.set(r.stopKey, s);
    }
    s.items.push({
      deliveryId: r.row._id!.toHexString(),
      kind: r.row.kind as MilkKind,
      litres: r.row.litres,
      source: r.row.source ?? 'plan',
      status: r.row.status,
    });
  }
  return [...byKey.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * The day's manifest — the frozen runs when the date is locked, otherwise a live
 * PREVIEW in the same shape computed with no writes (so ops can see tomorrow's load
 * before the cutoff). Past the cutoff the date is locked first (lazy lock).
 */
export async function getManifest(date: string, ctx: OpCtx): Promise<Manifest> {
  const db = await getDb();
  const rules = dayRulesOf(await getOpsSettings(db));
  if (isPastCutoff(date, ctx.now, rules)) await ensureLocked(date, ctx);

  const lock = await col.dayLocks(db).findOne({ _id: date });
  const riders = await col.riders(db).find({}).project<{ _id: ObjectId; name: string }>({ name: 1 }).toArray();
  const riderName = new Map(riders.map(r => [r._id.toHexString(), r.name]));
  const nameOf = (id: ObjectId | null | undefined) => (id ? (riderName.get(id.toHexString()) ?? 'Unknown rider') : 'Unassigned');

  const runs: ManifestRun[] = [];
  let deliveries = 0;

  if (lock) {
    const runDocs = await col.riderRuns(db).find({ date }).toArray();
    for (const run of runDocs) {
      const rows = await col.deliveries(db).find({ runId: run._id }).sort({ seq: 1 }).toArray();
      deliveries += rows.length;
      runs.push({
        runId: run._id!.toHexString(),
        riderId: run.riderId ? run.riderId.toHexString() : null,
        riderName: nameOf(run.riderId),
        status: run.status,
        load: run.load,
        stops: toManifestStops(
          rows.map(r => ({
            stopKey: r.stopKey ?? `${r.mobile}@pin:${r.pincode}`,
            seq: r.seq ?? 0,
            mobile: r.mobile,
            snapshot: r.snapshot ?? { name: r.mobile, address: `Pincode ${r.pincode}` },
            row: r,
          })),
        ),
      });
    }
  } else {
    // preview: exactly what a lock would do right now, without writing anything
    const planned = await resolveRows(db, date, OPEN_STATUSES);
    const byRider = new Map<string, { riderId: ObjectId | null; rows: PlannedRow[]; stops: Map<string, StopSnapshot> }>();
    for (const p of planned) {
      const k = riderKey(p.riderId);
      let g = byRider.get(k);
      if (!g) {
        g = { riderId: p.riderId, rows: [], stops: new Map() };
        byRider.set(k, g);
      }
      g.rows.push(p);
      if (!g.stops.has(p.stopKey)) g.stops.set(p.stopKey, p.snapshot);
    }
    for (const g of byRider.values()) {
      const ordered = await orderForRider(g.riderId, g.stops, ctx, false);
      const seqOf = new Map(ordered.order.map((k, i) => [k, i + 1]));
      deliveries += g.rows.length;
      runs.push({
        runId: null,
        riderId: g.riderId ? g.riderId.toHexString() : null,
        riderName: nameOf(g.riderId),
        status: 'preview',
        load: loadOf(g.rows.map(p => ({ kind: p.row.kind, litres: p.row.litres, stopKey: p.stopKey }))),
        stops: toManifestStops(
          g.rows.map(p => ({ stopKey: p.stopKey, seq: seqOf.get(p.stopKey) ?? 0, mobile: p.row.mobile, snapshot: p.snapshot, row: p.row })),
        ),
      });
    }
  }

  // unassigned first (it needs action), then riders by name
  runs.sort((a, b) => (a.riderId === null ? -1 : b.riderId === null ? 1 : a.riderName.localeCompare(b.riderName)));

  const totals = {
    cowLitres: round2(runs.reduce((s, r) => s + r.load.cowLitres, 0)),
    buffaloLitres: round2(runs.reduce((s, r) => s + r.load.buffaloLitres, 0)),
    stops: runs.reduce((s, r) => s + r.load.stops, 0),
    deliveries,
  };
  return { date, locked: Boolean(lock), lockAt: lockInstant(date, rules).toISOString(), runs, totals };
}

/** Coordinates helper for callers that only have a snapshot. */
export function snapshotPoint(s: StopSnapshot | undefined): LatLng | undefined {
  return s?.location;
}
