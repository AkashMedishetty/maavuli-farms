// Integration test for lib/route-plan.ts + lib/google-routes.ts against a real Mongo.
//   MONGODB_DB=maavuli_it_b4 pnpm db:init
//   MONGODB_DB=maavuli_it_b4 pnpm it scripts/it/b4-routes.ts
// Google is NEVER called for real: a fake fetch is injected. The test key below only
// flips googleRoutesConfigured(); it is not a credential.
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, stopKeyOf, type Subscription } from '@/lib/models';
import { systemCtx } from '@/lib/clock';
import { circleToPolygon } from '@/lib/geo';
import {
  __setRoutesFetchForTests,
  markRouteDirty,
  optimizeStandingRoute,
  orderStopsForRider,
  refreshStaleRoutes,
  riderStops,
} from '@/lib/route-plan';
import { buildRequestBody, googleUsage, parseResponse } from '@/lib/google-routes';

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

const db = await getDb();
const now = new Date('2026-10-05T10:00:00Z');
const ctx = systemCtx(now, 'it_b4');

// ---- clean slate for the collections this test owns ----
for (const c of ['zones', 'riders', 'subscriptions', 'standing_routes', 'api_usage', 'events'] as const) {
  await db.collection(c).deleteMany({});
}
delete process.env.GOOGLE_MAPS_SERVER_KEY;
delete process.env.GOOGLE_ROUTES_DAILY_CAP;
delete process.env.GOOGLE_ROUTES_MONTHLY_CAP;
process.env.FARM_ORIGIN_LAT = '17.4100';
process.env.FARM_ORIGIN_LNG = '78.5400';

// ---- fixtures: one rider, one zone, 6 doorsteps ----
const centre = { lat: 17.412, lng: 78.542 };
const riderId = new ObjectId();
await col.riders(db).insertOne({ _id: riderId, name: 'IT Rider', phone: '9840000001', active: true, createdAt: now, updatedAt: now });
const zoneId = new ObjectId();
await col.zones(db).insertOne({
  _id: zoneId,
  name: 'IT Zone',
  active: true,
  shape: { kind: 'circle', centre, radiusM: 3000 },
  geometry: circleToPolygon(centre, 3000),
  riderId,
  createdAt: now,
  updatedAt: now,
});

const points = [
  { lat: 17.4105, lng: 78.5410 },
  { lat: 17.4120, lng: 78.5430 },
  { lat: 17.4140, lng: 78.5450 },
  { lat: 17.4160, lng: 78.5470 },
  { lat: 17.4180, lng: 78.5490 },
  { lat: 17.4200, lng: 78.5510 },
];
const mobiles = points.map((_, i) => `98400001${String(i).padStart(2, '0')}`);
function sub(i: number, extra: Partial<Subscription> = {}): Subscription {
  return {
    orderId: new ObjectId(),
    mobile: mobiles[i]!,
    kind: 'cow',
    qtyNum: 1,
    qtyDen: 1,
    startDate: '2026-10-01',
    endDate: '2026-10-30',
    daysTotal: 30,
    daysDelivered: 0,
    daysPaused: 0,
    status: 'active',
    pauseAllowanceDays: 3,
    pauseUsedDays: 0,
    pincode: '500040',
    name: `Customer ${i}`,
    address: `House ${i}`,
    location: points[i]!,
    stopKey: stopKeyOf(mobiles[i]!, points[i]!),
    zoneId,
    createdAt: now,
    ...extra,
  };
}
await col.subscriptions(db).insertMany([0, 1, 2, 3, 4].map(i => sub(i)));
// a second (buffalo) subscription at doorstep 0 — must NOT become a second stop
await col.subscriptions(db).insertOne(sub(0, { kind: 'buffalo' }));
// a legacy row with no zoneId, inside the zone — must be picked up by point-in-polygon
await col.subscriptions(db).insertOne(sub(5, { zoneId: undefined }));
await col.subscriptions(db).updateOne({ mobile: mobiles[5] }, { $unset: { zoneId: '' } });
// a cancelled one — must be ignored
await col.subscriptions(db).insertOne(sub(3, { status: 'cancelled', mobile: '9840000199', stopKey: 'x@cancelled' }));

// ---- riderStops ----
const stops = await riderStops(riderId, db);
t('riderStops: 6 doorsteps (dedup cow+buffalo, legacy included, cancelled excluded)', stops.length === 6, stops.length);

// ---- no Google key: local solver ----
const r1 = await optimizeStandingRoute(riderId, ctx);
t('local: source local', r1.source === 'local');
t('local: all stops present', r1.stopOrder.length === 6 && new Set(r1.stopOrder).size === 6);
t('local: dirty false', r1.dirty === false);
t('local: version 1', r1.version === 1, r1.version);
const lineOrder = points.map((p, i) => stopKeyOf(mobiles[i]!, p));
t('local: a straight line from the farm is visited in order', r1.stopOrder.join() === lineOrder.join(), r1.stopOrder);

// ---- daily ordering: absent stops skipped, standing order kept ----
const standing = r1.stopOrder;
const today = stops.filter(s => s.stopKey !== standing[2]); // one customer paused today
const o1 = await orderStopsForRider(riderId, today, ctx);
t('order: paused stop skipped', o1.order.length === 5 && !o1.order.includes(standing[2]!));
t('order: standing relative order kept', o1.order.join() === standing.filter(k => k !== standing[2]).join(), o1.order);
const afterSkip = await col.standingRoutes(db).findOne({ riderId });
t('order: skipping does not dirty the route', afterSkip?.dirty === false);

// ---- a new stop is inserted cheapest-first and dirties the route ----
const newcomer = { stopKey: 'new@17.41300,78.54400', location: { lat: 17.413, lng: 78.544 } };
const o2 = await orderStopsForRider(riderId, [...stops, newcomer], ctx);
t('insert: all 7 present', o2.order.length === 7 && o2.order.includes(newcomer.stopKey));
const idx = o2.order.indexOf(newcomer.stopKey);
t('insert: slotted between its neighbours, not appended', idx > 0 && idx < 6, idx);
const dirtied = await col.standingRoutes(db).findOne({ riderId });
t('insert: route marked dirty', dirtied?.dirty === true && /new stop/.test(dirtied?.dirtyReason ?? ''), dirtied?.dirtyReason);

// ---- refresh (still no key) clears dirty ----
const ref1 = await refreshStaleRoutes(ctx);
t('refresh: optimised the dirty route', ref1.optimized === 1 && !ref1.capped, ref1);
t('refresh: dirty cleared', (await col.standingRoutes(db).findOne({ riderId }))?.dirty === false);

// ---- Google path with a fake fetch ----
process.env.GOOGLE_MAPS_SERVER_KEY = 'it-test-not-a-key';
let calls = 0;
let lastHeaders: Record<string, string> = {};
let lastBody: { intermediates?: unknown[]; travelMode?: string; optimizeWaypointOrder?: boolean } = {};
__setRoutesFetchForTests(async (_url, init) => {
  calls++;
  lastHeaders = init.headers as Record<string, string>;
  lastBody = JSON.parse(String(init.body));
  const n = (lastBody.intermediates ?? []).length;
  // reverse the intermediates to prove the result is applied, not ignored
  const order = Array.from({ length: n }, (_, i) => n - 1 - i);
  return new Response(JSON.stringify({ routes: [{ optimizedIntermediateWaypointIndex: order, distanceMeters: 4321, duration: '987s' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
const local = (await col.standingRoutes(db).findOne({ riderId }))!.stopOrder;
const g1 = await optimizeStandingRoute(riderId, ctx);
t('google: called once', calls === 1, calls);
t('google: DRIVE + optimizeWaypointOrder', lastBody.travelMode === 'DRIVE' && lastBody.optimizeWaypointOrder === true);
t('google: field mask asks for the optimised index', /optimizedIntermediateWaypointIndex/.test(lastHeaders['x-goog-fieldmask'] ?? ''));
t('google: 5 intermediates for 6 stops', (lastBody.intermediates ?? []).length === 5);
t('google: source google', g1.source === 'google');
t('google: order = reversed intermediates + fixed destination', g1.stopOrder.join() === [...local.slice(0, -1).reverse(), local[local.length - 1]].join(), { got: g1.stopOrder, local });
t('google: road distance + duration stored', g1.totalM === 4321 && g1.totalS === 987, { m: g1.totalM, s: g1.totalS });
t('google: usage counted', (await googleUsage(now, db)).today === 1);

// ---- the daily cap stops calls ----
process.env.GOOGLE_ROUTES_DAILY_CAP = '1';
await markRouteDirty(riderId, 'cap test', ctx);
const before = calls;
const ref2 = await refreshStaleRoutes(ctx);
t('cap: no fetch at the cap', calls === before, calls - before);
t('cap: refresh reports capped', ref2.capped === true && ref2.optimized === 0, ref2);
t('cap: route left dirty for tomorrow', (await col.standingRoutes(db).findOne({ riderId }))?.dirty === true);
const forced = await optimizeStandingRoute(riderId, ctx); // explicit admin action falls back
t('cap: manual optimise falls back to local', forced.source === 'local' && forced.dirty === false);
t('cap: usage never exceeds the cap', (await googleUsage(now, db)).today === 1);

// ---- the monthly cap too ----
process.env.GOOGLE_ROUTES_DAILY_CAP = '100';
process.env.GOOGLE_ROUTES_MONTHLY_CAP = '1';
const monthBefore = calls;
const forced2 = await optimizeStandingRoute(riderId, ctx);
t('monthly cap: no fetch, local fallback', calls === monthBefore && forced2.source === 'local');
t('monthly cap: day counter not consumed', (await googleUsage(now, db)).today === 1);
delete process.env.GOOGLE_ROUTES_MONTHLY_CAP;

// ---- a Google error falls back to local ----
__setRoutesFetchForTests(async () => new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'bad' } }), { status: 400 }));
const e1 = await optimizeStandingRoute(riderId, ctx);
t('error: falls back to local', e1.source === 'local' && e1.stopOrder.length === 6);
const ev = await col.events(db).find({ type: 'route.optimized' }).sort({ at: -1, _id: -1 }).limit(1).toArray();
t('error: fallback reason recorded', /400/.test(String((ev[0]?.data as { fallbackReason?: string } | undefined)?.fallbackReason ?? '')), ev[0]?.data);
t('error: the key never appears in the recorded reason', !JSON.stringify(ev[0]?.data ?? {}).includes('it-test-not-a-key'));

// ---- pure helpers ----
t('parse: bad permutation rejected', (() => {
  try {
    parseResponse({ routes: [{ optimizedIntermediateWaypointIndex: [0, 0] }] }, 2);
    return false;
  } catch {
    return true;
  }
})());
t('parse: one intermediate without an index → [0]', parseResponse({ routes: [{}] }, 1).order.join() === '0');
t('body: no via flags, no traffic-aware-optimal', !JSON.stringify(buildRequestBody({ origin: centre, destination: centre, intermediates: [centre] })).match(/via|TRAFFIC_AWARE_OPTIMAL/));

// ---- markRouteDirty tolerates null ----
await markRouteDirty(null, 'nothing', ctx);
t('markRouteDirty(null) is a no-op', true);

// ---- unassigned bucket: local order, no route row ----
const u = await orderStopsForRider(null, stops, ctx);
t('unassigned: local order of all stops', u.source === 'local' && u.order.length === 6);

__setRoutesFetchForTests(undefined);
delete process.env.GOOGLE_MAPS_SERVER_KEY;
console.log(`b4-routes: ${passed} passed, ${failed} failed · db=${db.databaseName}`);
process.exit(failed ? 1 : 0);
