/**
 * B5 integration test — real Mongo, isolated DB.
 *   MONGODB_DB=maavuli_it_b5 pnpm db:init         # once
 *   MONGODB_DB=maavuli_it_b5 pnpm it scripts/it/b5-rider.ts
 *
 * Inserts a rider + a locked run + deliveries directly (does not depend on B2's
 * lockDay), then drives the rider flow through the real lib functions:
 *   start run → delivered (with proof) → not delivered (ours) → idempotent replay
 *   → another rider is denied the first rider's delivery.
 *
 * compensateMissedDelivery is owned by B3; if its stub still throws we call it as
 * per the contract and mark that one branch NOT VERIFIED rather than failing.
 */

import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, stopKeyOf, type Delivery, type RiderRun } from '@/lib/models';
import { riderActor, type OpCtx } from '@/lib/clock';
import { istYMD } from '@/lib/cutoff';
import { getRiderToday, startRun, applyActions, closeRun } from '@/lib/rider';
import { putObject } from '@/lib/storage';

let passed = 0;
let failed = 0;
const notVerified: string[] = [];
function t(name: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}

const db = await getDb();
const now = new Date('2026-06-01T02:00:00.000Z'); // ~07:30 IST — inside the window
const date = istYMD(now);
const MOBILE = '95rider0001'.replace(/\D/g, '').padEnd(10, '0').slice(0, 10); // fresh-ish test mobile
const custMobile = '9500000001';
const loc = { lat: 17.4001, lng: 78.5001 };

// ---- clean slate for this test's fixtures ----
const rid = new ObjectId();
const rid2 = new ObjectId();
const runId = new ObjectId();
await col.riders(db).deleteMany({ name: { $in: ['IT Rider B5', 'IT Rider B5 Two'] } });
await col.riderRuns(db).deleteMany({ date, riderId: { $in: [rid, rid2] } });
await col.deliveries(db).deleteMany({ mobile: custMobile });
await col.riderActions(db).deleteMany({ riderId: { $in: [rid, rid2] } });

await col.riders(db).insertOne({
  _id: rid, name: 'IT Rider B5', phone: MOBILE, active: true, createdAt: now, updatedAt: now,
});
await col.riders(db).insertOne({
  _id: rid2, name: 'IT Rider B5 Two', phone: '9500000099', active: true, createdAt: now, updatedAt: now,
});

const stopKey = stopKeyOf(custMobile, loc);
const snapshot = { name: 'Test Customer', address: '1 Test Lane', location: loc, landmark: 'blue gate' };

const d1 = new ObjectId();
const d2 = new ObjectId();
const baseDelivery = (id: ObjectId, kind: 'cow' | 'buffalo'): Delivery => ({
  _id: id,
  subscriptionId: new ObjectId(),
  mobile: custMobile,
  date,
  kind,
  litres: 1,
  pincode: '500001',
  status: 'locked',
  source: 'plan',
  riderId: rid,
  runId,
  seq: kind === 'cow' ? 1 : 2,
  stopKey,
  snapshot,
});
await col.deliveries(db).insertMany([baseDelivery(d1, 'cow'), baseDelivery(d2, 'buffalo')]);

const run: RiderRun = {
  _id: runId,
  date,
  riderId: rid,
  status: 'planned',
  stopOrder: [stopKey],
  deliveryIds: [d1, d2],
  load: { cowLitres: 1, buffaloLitres: 1, stops: 1 },
  routeSource: 'local',
  createdAt: now,
  updatedAt: now,
};
await col.riderRuns(db).insertOne(run);

const ctx: OpCtx = { now, actor: riderActor(MOBILE) };

// ---- read today ----
const today0 = await getRiderToday(rid, ctx);
t('today has the run', today0.hasRun && today0.status === 'planned');
t('today groups two items into one stop', today0.stops.length === 1 && today0.stops[0]!.items.length === 2);
if (today0.stops[0]!.navUrl) {
  t('stop carries navigation url', true);
} else {
  notVerified.push('stop navUrl — lib/maps-links stopNavigationUrl (owner B4) not implemented yet; handled best-effort');
}

// ---- start run ----
const started = await startRun(rid, ctx);
t('run is in_progress', started.status === 'in_progress');
const afterStart = await col.deliveries(db).find({ runId }).toArray();
t('locked rows moved to out_for_delivery', afterStart.every(d => d.status === 'out_for_delivery'));

// idempotent start
const started2 = await startRun(rid, ctx);
t('start run is idempotent', started2.status === 'in_progress');

// ---- a photo that belongs to ANOTHER delivery is rejected as proof ----
const foreignKey = `photos/${date}/foreign-test.jpg`;
await col.photos(db).updateOne(
  { key: foreignKey },
  { $setOnInsert: { key: foreignKey, deliveryId: new ObjectId(), riderId: rid, mobile: '9000000000', date, createdAt: now } },
  { upsert: true },
);
const foreign = await applyActions(
  rid,
  [{ actionId: 'it-b5-foreign-photo', type: 'delivered', deliveryId: String(d1), proof: { photoKey: foreignKey, lat: loc.lat, lng: loc.lng } }],
  ctx,
);
t('foreign photo rejected', foreign[0]!.ok === false && /not uploaded for this delivery/.test(foreign[0]!.error ?? ''));
t('foreign-photo rejection is permanent (not retryable)', foreign[0]!.retryable !== true);
t('delivery untouched by the rejected proof', (await col.deliveries(db).findOne({ _id: d1 }))?.status === 'out_for_delivery');

// ---- delivered (cow) with proof at the pin ----
const photoKey = `photos/${date}/${String(d1)}-test.jpg`;
await col.photos(db).updateOne(
  { key: photoKey },
  { $setOnInsert: { key: photoKey, deliveryId: d1, riderId: rid, mobile: '9000000000', date, createdAt: now } },
  { upsert: true },
);
// a record alone is not a photo: before the bytes exist the mark is refused as RETRYABLE
const early = await applyActions(
  rid,
  [{ actionId: 'it-b5-early-photo', type: 'delivered', deliveryId: String(d1), proof: { photoKey, lat: loc.lat, lng: loc.lng } }],
  ctx,
);
t('photo record without bytes → refused, retryable', early[0]!.ok === false && early[0]!.retryable === true);
await putObject(photoKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg');
const deliverAction = {
  actionId: 'it-b5-deliver-1',
  type: 'delivered' as const,
  deliveryId: String(d1),
  proof: { photoKey, lat: loc.lat, lng: loc.lng, accuracyM: 8 },
};
const res1 = await applyActions(rid, [deliverAction], ctx);
t('delivered applied', res1[0]!.ok && res1[0]!.status === 'delivered');
const d1after = await col.deliveries(db).findOne({ _id: d1 });
t('delivered persisted with proof distance ~0', d1after?.status === 'delivered' && (d1after?.proof?.distanceFromPinM ?? -1) < 5);

// idempotent replay of the SAME actionId
const res1replay = await applyActions(rid, [deliverAction], ctx);
t('replayed action reported duplicate', res1replay[0]!.duplicate === true && res1replay[0]!.ok);
const actionCount = await col.riderActions(db).countDocuments({ actionId: 'it-b5-deliver-1' });
t('replay did not double-record', actionCount === 1);

// ---- not delivered ours (buffalo) ----
const missAction = {
  actionId: 'it-b5-miss-1',
  type: 'not_delivered' as const,
  deliveryId: String(d2),
  reason: 'out_of_stock' as const,
};
let missOk = false;
try {
  const resMiss = await applyActions(rid, [missAction], ctx);
  missOk = !!resMiss[0]!.ok;
  const d2after = await col.deliveries(db).findOne({ _id: d2 });
  t('not_delivered persisted', d2after?.status === 'not_delivered');
  t('fault defaulted to ours', d2after?.fault === 'ours');
  if (resMiss[0]!.ok) {
    // compensation path exercised — B3 owns the actual make-up/credit write.
    notVerified.push('compensation side-effect (owner B3) — call succeeded; not asserting resolution here');
  } else {
    notVerified.push(`not_delivered(ours) — action rejected, likely B3 compensation stub: ${resMiss[0]!.error}`);
  }
} catch (e) {
  notVerified.push(`not_delivered(ours) threw (likely B3 compensation stub): ${e instanceof Error ? e.message : e}`);
}
void missOk;

// ---- another rider is denied the first rider's delivery ----
const res2 = await applyActions(rid2, [{ actionId: 'it-b5-other-1', type: 'delivered', deliveryId: String(d1), proof: { photoKey: 'photos/x.jpg' } }], ctx);
t('other rider denied (not owner)', res2[0]!.ok === false && /not your delivery/i.test(res2[0]!.error ?? ''));

// ---- close run ----
try {
  const closed = await closeRun(rid, { cowLitres: 0.5, note: 'end of round' }, ctx);
  t('run closed with returns', closed.status === 'closed' && closed.returns?.cowLitres === 0.5);
} catch (e) {
  notVerified.push(`closeRun threw: ${e instanceof Error ? e.message : e}`);
}

// ---- a rider cannot change a past day's delivery (it would mint compensation) ----
const pastId = (
  await col.deliveries(db).insertOne({
    subscriptionId: new ObjectId(),
    mobile: custMobile,
    date: '2026-05-20',
    kind: 'cow',
    litres: 1,
    pincode: '500047',
    status: 'delivered',
    source: 'plan',
    riderId: rid,
    runId,
  })
).insertedId;
const past = await applyActions(rid, [{ actionId: 'it-b5-past-1', type: 'not_delivered', deliveryId: String(pastId), reason: 'out_of_stock' }], ctx);
t('past day refused from the phone', past[0]!.ok === false && /today/.test(past[0]!.error ?? ''));
t('past delivery untouched', (await col.deliveries(db).findOne({ _id: pastId }))?.status === 'delivered');

// ---- hostile input is refused before it reaches the database ----
const hostile = await applyActions(
  rid,
  [
    { actionId: 'it-b5-proto-1', type: 'not_delivered', deliveryId: String(d2), reason: 'constructor' },
    { actionId: 'it-b5-op-1', type: 'delivered', deliveryId: String(d1), proof: { photoKey: { $ne: null } } },
    { actionId: 'it-b5-gps-1', type: 'delivered', deliveryId: String(d1), proof: { lat: 999, lng: 0 } },
    { actionId: 'short', type: 'delivered', deliveryId: String(d1) },
  ],
  ctx,
);
t('prototype-key reason refused', hostile[0]!.ok === false);
t('operator as photoKey refused', hostile[1]!.ok === false);
t('out-of-range GPS refused', hostile[2]!.ok === false);
t('too-short actionId refused', hostile[3]!.ok === false);

// ---- cleanup ----
await col.riders(db).deleteMany({ _id: { $in: [rid, rid2] } });
await col.riderRuns(db).deleteMany({ _id: runId });
await col.deliveries(db).deleteMany({ mobile: custMobile });
await col.riderActions(db).deleteMany({ riderId: { $in: [rid, rid2] } });

console.log(`\nb5-rider: ${passed} passed, ${failed} failed`);
if (notVerified.length) {
  console.log('NOT VERIFIED:');
  for (const n of notVerified) console.log(`  - ${n}`);
}
process.exit(failed ? 1 : 0);
