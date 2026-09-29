/**
 * Admin (ops console) data access, server-only.
 *
 *  · Access: roles are resolved per request by lib/roles. `pageStaff()` is the
 *    page-side gate (cached per render so the layout and the page share one lookup);
 *    route handlers use `requireStaff([...])` directly. `NotAdminError` remains
 *    only because lib/api maps it to 403.
 *  · Read models for the ops screens that no other module owns: the exceptions
 *    queue, the disruption impact preview, and system health.
 *
 * Nothing here writes a delivery status — outcomes go through lib/outcomes via
 * POST /api/admin/deliveries/[id]/outcome.
 */

import { cache } from 'react';
import { ObjectId } from 'mongodb';
import { getPrincipal, type Principal } from '@/lib/roles';
import { getDb } from '@/lib/db';
import {
  col,
  type Delivery,
  type DeliveryStatus,
  type Fault,
  type NotDeliveredReason,
  type StaffRole,
  type Zone,
} from '@/lib/models';
import type { MilkKind } from '@/lib/pricing';
import type { OpCtx } from '@/lib/clock';
import { addDaysYMD, isPastCutoff, istYMD, isYMD, lockInstant } from '@/lib/cutoff';
import { dayRulesOf, getOpsSettings } from '@/lib/settings';
import { pointInPolygon } from '@/lib/geo';
import { ValidationError } from '@/lib/errors';

/* ------------------------------------------------------------- access ---- */

/** Thrown by legacy admin gates; lib/api maps it to 403. Kept for that mapping. */
export class NotAdminError extends Error {
  constructor(msg = 'Admin access required') {
    super(msg);
    this.name = 'NotAdminError';
  }
}

/** One principal lookup per server render (layout + page share it). */
export const adminPrincipal = cache(async (): Promise<Principal | null> => getPrincipal());

export type StaffPrincipal = Principal & { staffRole: StaffRole };

/** The signed-in staff member for a page, or null (the layout renders the prompt). */
export async function pageStaff(): Promise<StaffPrincipal | null> {
  const p = await adminPrincipal();
  if (!p || !p.staffRole) return null;
  return p as StaffPrincipal;
}

/** Ops actions (lock, assign, outcomes, disruptions, optimise) — contract §7. */
export function canOperate(role: StaffRole): boolean {
  return role === 'owner' || role === 'ops';
}

/** Short safe message for a failed server-side load (no stack, no secrets). */
export function loadErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'missing' in err && Array.isArray((err as { missing: unknown }).missing)) {
    return `Not configured — missing ${(err as { missing: string[] }).missing.join(', ')}.`;
  }
  return 'The database could not be reached, so this screen is not showing live data. Reload to retry.';
}

/* ------------------------------------------------------ subscriptions ---- */

export interface ActiveSubscriptionRow {
  subscriptionId: string;
  mobile: string;
  kind: MilkKind;
  litresPerDay: number;
  startDate: string;
  endDate: string;
  daysTotal: number;
  daysDelivered: number;
  pincode: string;
}

/** Every subscription currently active, most recently started first. */
export async function activeSubscriptions(): Promise<ActiveSubscriptionRow[]> {
  const db = await getDb();
  const rows = await col.subscriptions(db).find({ status: 'active' }).sort({ startDate: -1 }).toArray();
  return rows.map(s => ({
    subscriptionId: String(s._id),
    mobile: s.mobile,
    kind: s.kind,
    litresPerDay: s.qtyNum / s.qtyDen,
    startDate: s.startDate,
    endDate: s.endDate,
    daysTotal: s.daysTotal,
    daysDelivered: s.daysDelivered,
    pincode: s.pincode,
  }));
}

/* --------------------------------------------------------- exceptions ---- */

/** How far back the exceptions queue looks when no date is given. */
export const EXCEPTIONS_LOOKBACK_DAYS = 7;

export type ExceptionKind = 'unconfirmed' | 'unknown_fault' | 'flagged_proof';

export interface ExceptionItem {
  kind: ExceptionKind;
  deliveryId: string;
  date: string;
  status: DeliveryStatus;
  mobile: string;
  name: string;
  address: string;
  landmark?: string;
  zoneName?: string;
  riderName: string;
  milk: MilkKind;
  litres: number;
  source: 'plan' | 'makeup' | 'extra';
  reason?: NotDeliveredReason;
  reasonNote?: string;
  note?: string;
  fault?: Fault;
  proof?: {
    photoUrl?: string;
    distanceFromPinM?: number;
    capturedAt?: string;
    hasGps: boolean;
  };
}

export interface ExceptionsResult {
  from: string;
  to: string;
  unconfirmed: ExceptionItem[];
  unknownFault: ExceptionItem[];
  flaggedProofs: ExceptionItem[];
}

/** Same-origin URL of a private photo (the photos route enforces access). */
export function photoUrlFor(key: string): string {
  return `/api/photos/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The ops exceptions queue: unconfirmed deliveries, misses whose fault is unknown,
 * and delivered stops whose proof was flagged. One date, or the last
 * EXCEPTIONS_LOOKBACK_DAYS days up to today when `date` is omitted.
 */
export async function listExceptions(date: string | undefined, ctx: OpCtx): Promise<ExceptionsResult> {
  if (date !== undefined && !isYMD(date)) throw new ValidationError('date must be YYYY-MM-DD');
  const today = istYMD(ctx.now);
  const from = date ?? addDaysYMD(today, -EXCEPTIONS_LOOKBACK_DAYS);
  const to = date ?? today;

  const db = await getDb();
  const rows = await col
    .deliveries(db)
    .find({
      date: { $gte: from, $lte: to },
      $or: [
        { status: 'unconfirmed' },
        { status: 'not_delivered', fault: 'unknown' },
        { status: 'delivered', 'proof.flagged': true },
      ],
    })
    .sort({ date: -1, riderId: 1, seq: 1 })
    .limit(500)
    .toArray();

  const riderIds = [...new Set(rows.map(r => r.riderId?.toHexString()).filter((x): x is string => Boolean(x)))];
  const riders = riderIds.length
    ? await col
        .riders(db)
        .find({ _id: { $in: riderIds.map(id => new ObjectId(id)) } })
        .project<{ _id: ObjectId; name: string }>({ name: 1 })
        .toArray()
    : [];
  const riderName = new Map(riders.map(r => [r._id.toHexString(), r.name]));

  const out: ExceptionsResult = { from, to, unconfirmed: [], unknownFault: [], flaggedProofs: [] };
  for (const r of rows) {
    const kind: ExceptionKind =
      r.status === 'unconfirmed' ? 'unconfirmed' : r.status === 'not_delivered' ? 'unknown_fault' : 'flagged_proof';
    const item = toExceptionItem(kind, r, r.riderId ? (riderName.get(r.riderId.toHexString()) ?? 'Unknown rider') : 'Unassigned');
    if (kind === 'unconfirmed') out.unconfirmed.push(item);
    else if (kind === 'unknown_fault') out.unknownFault.push(item);
    else out.flaggedProofs.push(item);
  }
  return out;
}

function toExceptionItem(kind: ExceptionKind, r: Delivery, riderName: string): ExceptionItem {
  const snap = r.snapshot;
  const p = r.proof;
  return {
    kind,
    deliveryId: r._id!.toHexString(),
    date: r.date,
    status: r.status,
    mobile: r.mobile,
    name: snap?.name ?? r.mobile,
    address: snap?.address ?? `Pincode ${r.pincode}`,
    ...(snap?.landmark ? { landmark: snap.landmark } : {}),
    ...(snap?.zoneName ? { zoneName: snap.zoneName } : {}),
    riderName,
    milk: r.kind,
    litres: r.litres,
    source: r.source ?? 'plan',
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.reasonNote ? { reasonNote: r.reasonNote } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.fault ? { fault: r.fault } : {}),
    ...(p
      ? {
          proof: {
            ...(p.photoKey ? { photoUrl: photoUrlFor(p.photoKey) } : {}),
            ...(p.distanceFromPinM !== undefined ? { distanceFromPinM: Math.round(p.distanceFromPinM) } : {}),
            ...(p.capturedAt ? { capturedAt: p.capturedAt.toISOString() } : {}),
            hasGps: typeof p.lat === 'number' && typeof p.lng === 'number',
          },
        }
      : {}),
  };
}

/* ------------------------------------------------ disruption preview ---- */

/** Mirrors lib/disruptions MAX_DAYS_AHEAD (not imported to keep this module's graph small). */
const DISRUPTION_MAX_DAYS_AHEAD = 7;

export interface DisruptionPreview {
  date: string;
  zoneIds: string[];
  /** deliveries that would be marked not delivered (our fault) */
  affected: number;
  /** distinct customers who would be messaged */
  customers: number;
  /** of `affected`, rows not yet frozen — counted by their subscription's zone */
  unlockedRows: number;
}

/**
 * How many deliveries a disruption would hit, with NO writes. createDisruption locks
 * the day first, so planned rows count too: frozen rows are matched by their
 * snapshot zone (exactly as createDisruption does), planned rows by their
 * subscription's zone (cached zoneId, else point-in-polygon on the active zones —
 * the same resolution the lock uses).
 */
export async function disruptionPreview(date: string, zoneIds: ObjectId[], ctx: OpCtx): Promise<DisruptionPreview> {
  if (!isYMD(date)) throw new ValidationError('date must be YYYY-MM-DD');
  const today = istYMD(ctx.now);
  if (date < today) throw new ValidationError('A disruption cannot be declared for a past date.');
  if (date > addDaysYMD(today, DISRUPTION_MAX_DAYS_AHEAD)) {
    throw new ValidationError(`A disruption can be declared at most ${DISRUPTION_MAX_DAYS_AHEAD} days ahead.`);
  }

  const db = await getDb();
  if (zoneIds.length) {
    const found = await col.zones(db).countDocuments({ _id: { $in: zoneIds } });
    if (found !== zoneIds.length) throw new ValidationError('One or more zones do not exist.');
  }
  const wanted = new Set(zoneIds.map(z => z.toHexString()));

  const frozenFilter: Record<string, unknown> = {
    date,
    status: { $in: ['locked', 'out_for_delivery', 'unconfirmed'] satisfies DeliveryStatus[] },
  };
  if (zoneIds.length) frozenFilter['snapshot.zoneId'] = { $in: zoneIds };
  const frozen = await col.deliveries(db).find(frozenFilter).project<{ mobile: string }>({ mobile: 1 }).toArray();

  const open = await col
    .deliveries(db)
    .find({ date, status: { $in: ['planned', 'scheduled'] satisfies DeliveryStatus[] } })
    .project<{ mobile: string; subscriptionId: ObjectId }>({ mobile: 1, subscriptionId: 1 })
    .toArray();

  let openHits: { mobile: string }[] = open;
  if (zoneIds.length && open.length) {
    const subIds = [...new Set(open.map(o => o.subscriptionId.toHexString()))].map(id => new ObjectId(id));
    const subs = await col
      .subscriptions(db)
      .find({ _id: { $in: subIds } })
      .project<{ _id: ObjectId; zoneId?: ObjectId; location?: { lat: number; lng: number } }>({ zoneId: 1, location: 1 })
      .toArray();
    const zones: Zone[] = await col.zones(db).find({ active: true }).sort({ name: 1 }).toArray();
    const zoneOfSub = new Map<string, string | undefined>();
    for (const s of subs) {
      let z = s.zoneId?.toHexString();
      if (!z && s.location) {
        const loc = s.location;
        z = zones.find(zz => pointInPolygon(loc, zz.geometry))?._id?.toHexString();
      }
      zoneOfSub.set(s._id.toHexString(), z);
    }
    openHits = open.filter(o => {
      const z = zoneOfSub.get(o.subscriptionId.toHexString());
      return z !== undefined && wanted.has(z);
    });
  }

  const customers = new Set([...frozen, ...openHits].map(r => r.mobile));
  return {
    date,
    zoneIds: zoneIds.map(z => z.toHexString()),
    affected: frozen.length + openHits.length,
    customers: customers.size,
    unlockedRows: openHits.length,
  };
}

/* ------------------------------------------------------------- riders ---- */

export interface RiderOptionRow {
  id: string;
  name: string;
}

/** Active riders, by name — options for the assign control. */
export async function activeRiderOptions(): Promise<RiderOptionRow[]> {
  const db = await getDb();
  const rows = await col.riders(db).find({ active: true }).sort({ name: 1 }).project<{ _id: ObjectId; name: string }>({ name: 1 }).toArray();
  return rows.map(r => ({ id: r._id.toHexString(), name: r.name }));
}

export interface ZoneOptionRow {
  id: string;
  name: string;
  active: boolean;
}

export async function zoneOptions(): Promise<ZoneOptionRow[]> {
  const db = await getDb();
  const rows = await col
    .zones(db)
    .find({})
    .sort({ name: 1 })
    .project<{ _id: ObjectId; name: string; active: boolean }>({ name: 1, active: 1 })
    .toArray();
  return rows.map(z => ({ id: z._id.toHexString(), name: z.name, active: z.active }));
}

/* ------------------------------------------------------------- system ---- */

export interface DayLockState {
  date: string;
  /** a day_locks document exists (the manifest is frozen) */
  locked: boolean;
  /** time alone says the date is closed for customers */
  pastCutoff: boolean;
  lockAt: string;
  lockedAt: string | null;
  closedAt: string | null;
  stops: number | null;
}

export interface JobStep {
  step: string;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastError?: string;
  leased: boolean;
}

export interface SystemStatus {
  now: string;
  jobs: JobStep[];
  /** most recent lastRunAt across all steps — the tick's heartbeat */
  lastTickAt: string | null;
  failing: JobStep[];
  today: DayLockState;
  tomorrow: DayLockState;
}

export async function dayLockState(date: string, ctx: OpCtx): Promise<DayLockState> {
  const db = await getDb();
  const rules = dayRulesOf(await getOpsSettings(db));
  const lock = await col.dayLocks(db).findOne({ _id: date });
  return {
    date,
    locked: Boolean(lock),
    pastCutoff: isPastCutoff(date, ctx.now, rules),
    lockAt: lockInstant(date, rules).toISOString(),
    lockedAt: lock ? lock.lockedAt.toISOString() : null,
    closedAt: lock?.closedAt ? lock.closedAt.toISOString() : null,
    stops: lock ? lock.stops : null,
  };
}

export async function systemStatus(ctx: OpCtx): Promise<SystemStatus> {
  // dynamic import: lib/jobs pulls in every tick module; lib/api imports this file
  const { jobStatus } = await import('@/lib/jobs');
  const jobs = await jobStatus();
  const today = istYMD(ctx.now);
  const [t0, t1] = await Promise.all([dayLockState(today, ctx), dayLockState(addDaysYMD(today, 1), ctx)]);
  const lastTickAt = jobs.reduce<string | null>((m, j) => (j.lastRunAt && (!m || j.lastRunAt > m) ? j.lastRunAt : m), null);
  return {
    now: ctx.now.toISOString(),
    jobs,
    lastTickAt,
    failing: jobs.filter(j => j.lastOk === false),
    today: t0,
    tomorrow: t1,
  };
}
