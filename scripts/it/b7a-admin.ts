// Integration test for the ops read models in lib/admin (B7a).
//   MONGODB_DB=maavuli_it_b7a pnpm db:init
//   MONGODB_DB=maavuli_it_b7a pnpm run it scripts/it/b7a-admin.ts
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, type Delivery, type Subscription } from '@/lib/models';
import { systemCtx, type OpCtx } from '@/lib/clock';
import { circleToPolygon } from '@/lib/geo';
import { addDaysYMD, istInstant } from '@/lib/cutoff';
import { lockDay } from '@/lib/manifest';
import { disruptionPreview, listExceptions, photoUrlFor, systemStatus } from '@/lib/admin';

if (!process.env.MONGODB_DB?.startsWith('maavuli_it_')) {
  console.log('refusing to run: MONGODB_DB must be an isolated maavuli_it_* database');
  process.exit(1);
}

let passed = 0;
let failed = 0;
function t(name: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}
async function throws(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    t(name, false, 'did not throw');
  } catch {
    t(name, true);
  }
}

const db = await getDb();
for (const c of ['zones', 'riders', 'subscriptions', 'deliveries', 'rider_runs', 'day_locks', 'standing_routes', 'events', 'outbox', 'job_runs', 'disruptions', 'settings']) {
  await db.collection(c).deleteMany({});
}
delete process.env.GOOGLE_MAPS_SERVER_KEY;

const TODAY = '2026-11-02';
const D = addDaysYMD(TODAY, 1);
const ctx: OpCtx = systemCtx(istInstant(TODAY, '09:00'), 'it_b7a'); // before tomorrow's 16:00 cutoff
const now0 = ctx.now;

const r1 = new ObjectId();
await col.riders(db).insertOne({ _id: r1, name: 'B7a Rider', phone: '9770000001', active: true, createdAt: now0, updatedAt: now0 });
const z1 = new ObjectId();
const z2 = new ObjectId();
const c1 = { lat: 17.47, lng: 78.54 };
const c2 = { lat: 17.40, lng: 78.40 };
await col.zones(db).insertMany([
  { _id: z1, name: 'Z1', active: true, shape: { kind: 'circle', centre: c1, radiusM: 1000 }, geometry: circleToPolygon(c1, 1000) as never, riderId: r1, createdAt: now0, updatedAt: now0 },
  { _id: z2, name: 'Z2', active: true, shape: { kind: 'circle', centre: c2, radiusM: 1000 }, geometry: circleToPolygon(c2, 1000) as never, createdAt: now0, updatedAt: now0 },
]);

function sub(mobile: string, loc: { lat: number; lng: number }, zoneId?: ObjectId): Subscription {
  return {
    _id: new ObjectId(), orderId: new ObjectId(), mobile, kind: 'cow', qtyNum: 1, qtyDen: 1,
    startDate: TODAY, endDate: addDaysYMD(TODAY, 29), daysTotal: 30, daysDelivered: 0, daysPaused: 0,
    status: 'active', pauseAllowanceDays: 3, pauseUsedDays: 0, pincode: '500001', name: `N ${mobile}`,
    address: `A ${mobile}`, location: loc, ...(zoneId ? { zoneId } : {}), createdAt: now0,
  };
}
const s1 = sub('9770000101', c1, z1);
const s2 = sub('9770000102', c2); // no cached zoneId → point-in-polygon
await col.subscriptions(db).insertMany([s1, s2]);
const planned = (s: Subscription): Delivery => ({
  _id: new ObjectId(), subscriptionId: s._id!, mobile: s.mobile, date: D, kind: 'cow', litres: 1, pincode: '500001', status: 'planned', source: 'plan',
});
await col.deliveries(db).insertMany([planned(s1), planned(s2)]);

// ---- disruption preview (no writes) ----
const pAll = await disruptionPreview(D, [], ctx);
t('preview all zones = 2', pAll.affected === 2 && pAll.customers === 2 && pAll.unlockedRows === 2, pAll);
const pZ1 = await disruptionPreview(D, [z1], ctx);
t('preview Z1 (cached zoneId) = 1', pZ1.affected === 1, pZ1);
const pZ2 = await disruptionPreview(D, [z2], ctx);
t('preview Z2 (point-in-polygon) = 1', pZ2.affected === 1, pZ2);
t('preview wrote nothing', (await col.deliveries(db).countDocuments({ date: D, status: 'planned' })) === 2 && (await col.dayLocks(db).countDocuments({})) === 0);
await throws('preview rejects past date', () => disruptionPreview(addDaysYMD(TODAY, -1), [], ctx));
await throws('preview rejects > 7 days ahead', () => disruptionPreview(addDaysYMD(TODAY, 8), [], ctx));
await throws('preview rejects unknown zone', () => disruptionPreview(D, [new ObjectId()], ctx));

await lockDay(D, ctx);
const pZ2L = await disruptionPreview(D, [z2], ctx);
t('preview after lock uses snapshot zone', pZ2L.affected === 1 && pZ2L.unlockedRows === 0, pZ2L);

// ---- exceptions ----
const base = (status: Delivery['status'], date: string, extra: Partial<Delivery> = {}): Delivery => ({
  _id: new ObjectId(), subscriptionId: new ObjectId(), mobile: s1.mobile, date, kind: 'cow', litres: 1, pincode: '500001', status, source: 'makeup',
  riderId: r1, snapshot: { name: 'Snap Name', address: 'Snap Addr', zoneName: 'Z1' }, ...extra,
});
const Y = addDaysYMD(TODAY, -1);
await col.deliveries(db).insertMany([
  base('unconfirmed', Y),
  base('not_delivered', Y, { reason: 'could_not_find', fault: 'unknown' }),
  base('not_delivered', Y, { reason: 'refused', fault: 'customer' }), // not an exception
  base('delivered', Y, { proof: { photoKey: 'photos/2026-11-01/abc-1.jpg', distanceFromPinM: 412.4, lat: 1, lng: 2, flagged: true, capturedAt: now0 } }),
  base('delivered', Y, { proof: { photoKey: 'photos/x.jpg', flagged: false } }), // not an exception
  base('unconfirmed', addDaysYMD(TODAY, -9)), // outside the 7-day lookback
]);
const ex = await listExceptions(Y, ctx);
t('exceptions: 1 unconfirmed', ex.unconfirmed.length === 1, ex.unconfirmed.length);
t('exceptions: 1 unknown fault', ex.unknownFault.length === 1 && ex.unknownFault[0]?.reason === 'could_not_find');
t('exceptions: 1 flagged proof', ex.flaggedProofs.length === 1);
const f = ex.flaggedProofs[0];
t('flagged item carries photo url + distance + rider', f?.proof?.photoUrl === '/api/photos/photos/2026-11-01/abc-1.jpg' && f.proof.distanceFromPinM === 412 && f.riderName === 'B7a Rider' && f.name === 'Snap Name', f);
t('item source preserved', ex.unconfirmed[0]?.source === 'makeup');
const exAll = await listExceptions(undefined, ctx);
t('lookback excludes 9-day-old row', exAll.unconfirmed.length === 1 && exAll.from === addDaysYMD(TODAY, -7) && exAll.to === TODAY, exAll.unconfirmed.length);
await throws('exceptions rejects bad date', () => listExceptions('2026-13-01', ctx));
t('photoUrlFor encodes segments', photoUrlFor('photos/a b/c.jpg') === '/api/photos/photos/a%20b/c.jpg');

// ---- system ----
await col.jobRuns(db).insertMany([
  { _id: 'lockDueDays', lastRunAt: new Date(now0.getTime() - 60_000), lastOk: true },
  { _id: 'drainOutbox', lastRunAt: new Date(now0.getTime() - 120_000), lastOk: false, lastError: 'boom' },
]);
const sys = await systemStatus(ctx);
t('system: failing step reported', sys.failing.length === 1 && sys.failing[0]?.step === 'drainOutbox' && sys.failing[0].lastError === 'boom', sys.failing);
t('system: lastTickAt = newest step run', sys.lastTickAt === new Date(now0.getTime() - 60_000).toISOString(), sys.lastTickAt);
t('system: tomorrow locked (we locked D)', sys.tomorrow.date === D && sys.tomorrow.locked && !sys.tomorrow.pastCutoff, sys.tomorrow);
t('system: today not locked, past cutoff', sys.today.date === TODAY && !sys.today.locked && sys.today.pastCutoff, sys.today);

console.log(`b7a-admin: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
