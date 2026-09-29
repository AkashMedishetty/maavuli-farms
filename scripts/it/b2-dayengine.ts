// Integration test for the day engine (lib/manifest, lib/jobs, lib/disruptions).
//   MONGODB_DB=maavuli_it_b2 pnpm db:init
//   MONGODB_DB=maavuli_it_b2 pnpm it scripts/it/b2-dayengine.ts
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, stopKeyOf, type Delivery, type Subscription } from '@/lib/models';
import { systemCtx, staffActor, type OpCtx } from '@/lib/clock';
import { circleToPolygon } from '@/lib/geo';
import { istInstant, addDaysYMD } from '@/lib/cutoff';
import {
  autoResolveStaleUnconfirmed,
  closeDueDays,
  ensureLocked,
  getManifest,
  lockDay,
  lockDueDays,
  reassignRun,
} from '@/lib/manifest';
import { runTick, withLease } from '@/lib/jobs';
import { createDisruption } from '@/lib/disruptions';
import { startRun } from '@/lib/rider';

if (!process.env.MONGODB_DB?.startsWith('maavuli_it_')) {
  console.log('refusing to run: MONGODB_DB must be an isolated maavuli_it_* database');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const notVerified: string[] = [];
function t(name: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const db = await getDb();
for (const c of [
  'zones', 'riders', 'subscriptions', 'deliveries', 'rider_runs', 'day_locks', 'standing_routes',
  'events', 'outbox', 'job_runs', 'disruptions', 'users', 'settings', 'credits',
] as const) {
  await db.collection(c).deleteMany({});
}
delete process.env.GOOGLE_MAPS_SERVER_KEY;

const D = '2026-10-10';
const D2 = '2026-10-12';
const at = (ymd: string, hm: string): OpCtx => systemCtx(istInstant(ymd, hm), 'it_b2');

// ---- fixtures: two riders, two zones ----
const now0 = istInstant('2026-10-08', '09:00');
const r1 = new ObjectId();
const r2 = new ObjectId();
const r3 = new ObjectId(); // a cover rider with no zone
await col.riders(db).insertMany([
  { _id: r1, name: 'Zone-1 Rider', phone: '9820000001', active: true, createdAt: now0, updatedAt: now0 },
  { _id: r2, name: 'Zone-2 Rider', phone: '9820000002', active: true, createdAt: now0, updatedAt: now0 },
  { _id: r3, name: 'Cover Rider', phone: '9820000003', active: true, createdAt: now0, updatedAt: now0 },
]);
const c1 = { lat: 17.4735, lng: 78.5468 };
const c2 = { lat: 17.4508, lng: 78.5358 };
const z1 = new ObjectId();
const z2 = new ObjectId();
await col.zones(db).insertMany([
  { _id: z1, name: 'IT Zone 1', active: true, shape: { kind: 'circle', centre: c1, radiusM: 1500 }, geometry: circleToPolygon(c1, 1500), riderId: r1, createdAt: now0, updatedAt: now0 },
  { _id: z2, name: 'IT Zone 2', active: true, shape: { kind: 'circle', centre: c2, radiusM: 1500 }, geometry: circleToPolygon(c2, 1500), riderId: r2, createdAt: now0, updatedAt: now0 },
]);

interface Cust { mobile: string; loc?: { lat: number; lng: number }; zoneId?: ObjectId; name: string }
const A: Cust = { mobile: '9820000101', loc: { lat: 17.4740, lng: 78.5470 }, zoneId: z1, name: 'Asha' };
const B: Cust = { mobile: '9820000102', loc: { lat: 17.4760, lng: 78.5480 }, zoneId: z1, name: 'Bala' };
const C: Cust = { mobile: '9820000103', loc: { lat: 17.4510, lng: 78.5360 }, zoneId: z2, name: 'Chitra' };
const OUT: Cust = { mobile: '9820000104', loc: { lat: 17.3000, lng: 78.3000 }, name: 'Far Away' }; // no zone
const NOPIN: Cust = { mobile: '9820000105', name: 'No Pin' }; // legacy, no location

function sub(c: Cust, kind: 'cow' | 'buffalo', startDate: string, extra: Partial<Subscription> = {}): Subscription {
  return {
    _id: new ObjectId(),
    orderId: new ObjectId(),
    mobile: c.mobile,
    kind,
    qtyNum: 1,
    qtyDen: 1,
    startDate,
    endDate: addDaysYMD(startDate, 29),
    daysTotal: 30,
    daysDelivered: 0,
    daysPaused: 0,
    status: 'active',
    pauseAllowanceDays: 3,
    pauseUsedDays: 0,
    pincode: '500047',
    name: c.name,
    address: `${c.name}'s house, Safilguda`,
    ...(c.loc ? { location: c.loc, stopKey: stopKeyOf(c.mobile, c.loc) } : {}),
    ...(c.zoneId ? { zoneId: c.zoneId } : {}),
    createdAt: now0,
    ...extra,
  };
}
const subs = [
  sub(A, 'cow', D, { status: 'scheduled' }), // first delivery on D → notice at lock
  sub(A, 'buffalo', '2026-10-01'), // same doorstep → one stop, two items
  sub(B, 'cow', '2026-10-01'),
  sub(C, 'cow', '2026-10-01'),
  sub(OUT, 'cow', '2026-10-01'),
  sub(NOPIN, 'cow', '2026-10-01'),
];
await col.subscriptions(db).insertMany(subs);
await col.users(db).insertMany(
  [A, B, C, OUT, NOPIN].map(c => ({ mobile: c.mobile, name: c.name, whatsappOptIn: true, createdAt: now0 })),
);

function row(s: Subscription, date: string, source: Delivery['source'] = 'plan'): Delivery {
  return { subscriptionId: s._id!, mobile: s.mobile, date, kind: s.kind, litres: 1, pincode: s.pincode, status: 'planned', source, updatedAt: now0 };
}
await col.deliveries(db).insertMany([...subs.map(s => row(s, D)), ...subs.map(s => row(s, D2))]);

// ---- before the cutoff: nothing locks; the preview writes nothing ----
const before = at('2026-10-09', '15:59');
t('before cutoff: ensureLocked → null', (await ensureLocked(D, before)) === null);
const preview = await getManifest(D, before);
t('preview: not locked', preview.locked === false);
t('preview: 6 deliveries', preview.totals.deliveries === 6, preview.totals);
t('preview: unassigned bucket first', preview.runs[0]?.riderId === null, preview.runs.map(r => r.riderName));
t('preview: A cow+buffalo is ONE stop with two items',
  preview.runs.find(r => r.riderId === r1.toHexString())?.stops.find(s => s.mobile === A.mobile)?.items.length === 2);
t('preview: rows still planned', (await col.deliveries(db).countDocuments({ date: D, status: 'planned' })) === 6);
t('preview: no day lock written', (await col.dayLocks(db).countDocuments({})) === 0);
t('preview: no standing route rows written', (await col.standingRoutes(db).countDocuments({})) === 0);

// ---- at the cutoff the tick step locks D ----
const cutoff = at('2026-10-09', '16:00');
const lk = await lockDueDays(cutoff);
t('lockDueDays locked D', lk.locked.includes(D), lk);
t('D2 not locked yet', !lk.locked.includes(D2));
const lockedRows = await col.deliveries(db).find({ date: D }).toArray();
t('all 6 rows locked', lockedRows.every(r => r.status === 'locked'), lockedRows.map(r => r.status));
t('every locked row has runId, seq, stopKey, snapshot', lockedRows.every(r => r.runId && r.seq && r.stopKey && r.snapshot?.name));
const byMobile = (m: string) => lockedRows.filter(r => r.mobile === m);
t('A rows → rider 1', byMobile(A.mobile).every(r => r.riderId?.equals(r1)));
t('C row → rider 2', byMobile(C.mobile).every(r => r.riderId?.equals(r2)));
t('outside-zone row → unassigned', byMobile(OUT.mobile).every(r => r.riderId === null));
t('pinless row → unassigned', byMobile(NOPIN.mobile).every(r => r.riderId === null));
t('snapshot carries zone name', byMobile(A.mobile)[0]?.snapshot?.zoneName === 'IT Zone 1');
t('A cow + buffalo share one seq', new Set(byMobile(A.mobile).map(r => r.seq)).size === 1);
const runs = await col.riderRuns(db).find({ date: D }).toArray();
t('3 runs (r1, r2, unassigned)', runs.length === 3, runs.length);
const run1 = runs.find(r => r.riderId?.equals(r1))!;
t('run 1 load: 3 litres over 2 stops', run1.load.stops === 2 && run1.load.cowLitres + run1.load.buffaloLitres === 3, run1.load);
t('run 1 stop order covers its stops', run1.stopOrder.length === 2);
const lock = await col.dayLocks(db).findOne({ _id: D });
t('day lock written with counts', lock?.stops === 5 && lock?.cowLitres === 5 && lock?.buffaloLitres === 1, lock);
t('day.locked event', (await col.events(db).countDocuments({ type: 'day.locked', entityId: D })) === 1);
const firstNotice = await col.outbox(db).findOne({ dedupeKey: `first_delivery:${subs[0]!._id!.toHexString()}` });
t('first-delivery notice queued for the plan starting on D', firstNotice !== null && firstNotice.template === 'first_delivery_tomorrow');
t('no first-delivery notice for plans that started earlier',
  (await col.outbox(db).countDocuments({ template: 'first_delivery_tomorrow' })) === 1);
t('lock marked the rider routes dirty (no standing route yet)',
  (await col.standingRoutes(db).countDocuments({ dirty: true })) >= 2);

// ---- idempotent re-lock ----
const again = await lockDay(D, cutoff);
t('re-lock keeps the lock', again.lockedAt.getTime() === lock!.lockedAt.getTime());
t('re-lock: still 3 runs', (await col.riderRuns(db).countDocuments({ date: D })) === 3);
t('re-lock: no second day.locked event', (await col.events(db).countDocuments({ type: 'day.locked', entityId: D })) === 1);

// a late planned row (ops-added) is picked up and the not-started run re-sequenced
const late = sub(B, 'buffalo', '2026-10-01');
await col.subscriptions(db).insertOne(late);
await col.deliveries(db).insertOne(row(late, D));
await ensureLocked(D, at('2026-10-09', '16:05'));
const lateRow = await col.deliveries(db).findOne({ subscriptionId: late._id!, date: D });
t('late row locked into rider 1 run', lateRow?.status === 'locked' && lateRow.runId?.equals(run1._id!) === true);
const bRows = await col.deliveries(db).find({ date: D, mobile: B.mobile }).toArray();
t('late row shares B stop seq', new Set(bRows.map(r => r.seq)).size === 1);
t('relock event recorded', (await col.events(db).countDocuments({ type: 'day.relocked', entityId: D })) === 1);

// ---- a lease blocks a concurrent run of the same step ----
const held = await withLease('lockDueDays', 60_000, async () => {
  const inner = await runTick(cutoff, { only: ['lockDueDays'] });
  return inner[0];
});
t('concurrent tick step skipped while leased', held?.value?.skipped === 'leased', held?.value);

// ---- cover rider ----
const run2 = runs.find(r => r.riderId?.equals(r2))!;
const moved = await reassignRun(run2._id!, r3, systemCtx(cutoff.now, 'it_b2'));
t('run reassigned to cover rider', moved.riderId?.equals(r3) === true);
t('territory owner remembered', moved.territoryRiderId?.equals(r2) === true);
t('deliveries follow the run', (await col.deliveries(db).countDocuments({ runId: run2._id!, riderId: r3 })) === 1);
let clash = false;
try {
  await reassignRun(run1._id!, r3, systemCtx(cutoff.now, 'it_b2'));
} catch {
  clash = true;
}
t('cover rider cannot hold two runs on one date', clash);

// ---- the rider starts; then the day closes ----
await startRun(r1, at(D, '06:00'));
t('run 1 started → its rows out for delivery',
  (await col.deliveries(db).countDocuments({ runId: run1._id!, status: 'out_for_delivery' })) === 4);
const notYet = await closeDueDays(at(D, '09:59'));
t('before day close: nothing closes', notYet.closed.length === 0, notYet);
const closed = await closeDueDays(at(D, '10:00'));
t('day close: D closed', closed.closed.includes(D), closed);
t('day close: 7 rows unconfirmed', closed.unconfirmed === 7, closed.unconfirmed);
t('day close: runs closed', (await col.riderRuns(db).countDocuments({ date: D, status: { $ne: 'closed' } })) === 0);
t('day close: closedAt set', (await col.dayLocks(db).findOne({ _id: D }))?.closedAt !== undefined);
const closedAgain = await closeDueDays(at(D, '10:05'));
t('day close is idempotent', !closedAgain.closed.includes(D), closedAgain);

// ---- unconfirmed → not delivered (ours) only after 24 h ----
const early = await autoResolveStaleUnconfirmed(at(addDaysYMD(D, 1), '09:59'));
t('auto-resolve waits 24 h', early.resolved === 0);
const res = await autoResolveStaleUnconfirmed(at(addDaysYMD(D, 1), '10:00'));
t('auto-resolve after 24 h resolves all 7', res.resolved === 7, res);
const nd = await col.deliveries(db).find({ date: D }).toArray();
t('auto-resolved rows are not_delivered, reason other, fault OURS', nd.every(r => r.status === 'not_delivered' && r.reason === 'other' && r.fault === 'ours'));
const compensated = nd.filter(r => r.resolution);
if (compensated.length === nd.length) t('auto-resolved rows compensated', true);
else notVerified.push(`compensation of auto-resolved misses (${compensated.length}/${nd.length} resolved) — lib/compensation (B3) not implemented yet; the tick sweep retries`);

// ---- a disruption on D2, zone 1 only ----
const disruptCtx: OpCtx = { now: istInstant('2026-10-11', '08:00'), actor: staffActor('9800000011') };
const dis = await createDisruption({ date: D2, zoneIds: [z1], reason: 'Heavy rain in Safilguda' }, disruptCtx);
t('disruption: D2 locked first', (await col.dayLocks(db).countDocuments({ _id: D2 })) === 1);
t('disruption: zone-1 rows affected (A cow, A buffalo, B cow)', dis.affected === 3, dis);
t('disruption: 2 customers notified', dis.customers === 2 && (await col.outbox(db).countDocuments({ template: 'disruption_notice' })) === 2);
const d2rows = await col.deliveries(db).find({ date: D2 }).toArray();
t('disruption: zone-1 rows not_delivered, reason disruption, fault ours',
  d2rows.filter(r => r.snapshot?.zoneId?.equals(z1)).every(r => r.status === 'not_delivered' && r.reason === 'disruption' && r.fault === 'ours'));
t('disruption: other zones untouched', d2rows.filter(r => !r.snapshot?.zoneId?.equals(z1)).every(r => r.status === 'locked'));
let pastRejected = false;
try {
  await createDisruption({ date: D, zoneIds: [], reason: 'too late' }, disruptCtx);
} catch {
  pastRejected = true;
}
t('disruption: a past date is refused', pastRejected);

// ---- a full tick keeps going past a failing step ----
const tick = await runTick(at('2026-10-12', '10:30'), { force: true });
t('tick ran every step', tick.length === 11, tick.map(s => s.step));
const failedSteps = tick.filter(s => !s.ok);
t('tick: day-engine steps ok', ['lockDueDays', 'closeDueDays', 'autoResolveStaleUnconfirmed'].every(n => tick.find(s => s.step === n)?.ok));
if (failedSteps.length) {
  notVerified.push(`tick steps still stubbed by other lanes: ${failedSteps.map(s => s.step).join(', ')} (isolated — the tick continued)`);
}
const status = await col.jobRuns(db).find({}).toArray();
t('tick recorded lastRunAt for every step', status.length === 11 && status.every(s => s.lastRunAt));

console.log(`b2-dayengine: ${passed} passed, ${failed} failed · db=${db.databaseName}`);
if (notVerified.length) console.log(`NOT VERIFIED:\n  - ${notVerified.join('\n  - ')}`);
process.exit(failed ? 1 : 0);
