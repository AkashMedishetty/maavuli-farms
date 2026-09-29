/**
 * B9 integration test — real Mongo, isolated DB.
 *   MONGODB_DB=maavuli_it_b9 pnpm db:init
 *   MONGODB_DB=maavuli_it_b9 pnpm run it scripts/it/b9-account.ts
 *
 * Fixtures inserted directly: two zones (each with its own rider), one active plan
 * in zone A with planned + locked + delivered + not_delivered rows. Then drives
 * lib/account: getAccountView, changeAddress (outside zone → 400; inside zone B →
 * plan/profile/planned rows updated, locked row untouched, both routes dirty),
 * updatePreferences, reportDeliveryProblem (own / another's / future / duplicate).
 */

import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, stopKeyOf, type Delivery } from '@/lib/models';
import { customerActor, type OpCtx } from '@/lib/clock';
import { addDaysYMD, istYMD } from '@/lib/cutoff';
import { circleToPolygon } from '@/lib/geo';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/errors';
import { changeAddress, getAccountView, parseTicketInput, reportDeliveryProblem, updatePreferences, parseAddressInput } from '@/lib/account';

let passed = 0;
let failed = 0;
function t(name: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}
async function throwsAs(name: string, fn: () => Promise<unknown>, cls: new (...a: never[]) => Error): Promise<void> {
  try {
    await fn();
    t(`${name} (expected throw)`, false);
  } catch (e) {
    t(name, e instanceof cls);
    if (!(e instanceof cls)) console.log('   got', e instanceof Error ? `${e.name}: ${e.message}` : e);
  }
}

const db = await getDb();
// 10:00 IST: today's cutoff (16:00) not reached → tomorrow is still open
const now = new Date('2026-07-10T04:30:00.000Z');
const today = istYMD(now);
const tomorrow = addDaysYMD(today, 1);
const ctx: OpCtx = { now, actor: customerActor('9900000901') };
const M = '9900000901';
const OTHER = '9900000902';

// ---- clean slate ----
const oldSubs = await col.subscriptions(db).find({ mobile: { $in: [M, OTHER] } }).toArray();
await col.deliveries(db).deleteMany({ mobile: { $in: [M, OTHER] } });
await col.subscriptions(db).deleteMany({ mobile: { $in: [M, OTHER] } });
await col.tickets(db).deleteMany({ mobile: { $in: [M, OTHER] } });
await col.events(db).deleteMany({ mobile: { $in: [M, OTHER] } });
await col.users(db).deleteMany({ mobile: { $in: [M, OTHER] } });
await col.zones(db).deleteMany({ name: /^it-b9-/ });
await col.riders(db).deleteMany({ name: /^it-b9-/ });
await col.dayLocks(db).deleteMany({ _id: { $in: [today, tomorrow] } });
void oldSubs;

const riderA = (await col.riders(db).insertOne({ name: 'it-b9-A', active: true, createdAt: now, updatedAt: now })).insertedId;
const riderB = (await col.riders(db).insertOne({ name: 'it-b9-B', active: true, createdAt: now, updatedAt: now })).insertedId;
await col.standingRoutes(db).deleteMany({ riderId: { $in: [riderA, riderB] } });
const cA = { lat: 17.3, lng: 78.3 };
const cB = { lat: 17.5, lng: 78.6 };
const zoneA = (
  await col.zones(db).insertOne({
    name: 'it-b9-A', active: true, shape: { kind: 'circle', centre: cA, radiusM: 2000 },
    geometry: circleToPolygon(cA, 2000), riderId: riderA, createdAt: now, updatedAt: now,
  })
).insertedId;
await col.zones(db).insertOne({
  name: 'it-b9-B', active: true, shape: { kind: 'circle', centre: cB, radiusM: 2000 },
  geometry: circleToPolygon(cB, 2000), riderId: riderB, createdAt: now, updatedAt: now,
});

await col.users(db).insertMany([
  { mobile: M, name: 'IT Nine', createdAt: now, location: cA, address: 'Old 1', whatsappOptIn: false },
  { mobile: OTHER, createdAt: now },
]);

const subId = new ObjectId();
const oldKey = stopKeyOf(M, cA);
const start = addDaysYMD(today, -3);
await col.subscriptions(db).insertOne({
  _id: subId, orderId: new ObjectId(), mobile: M, kind: 'cow', qtyNum: 1, qtyDen: 1,
  startDate: start, endDate: addDaysYMD(start, 29), daysTotal: 30, daysDelivered: 2, daysPaused: 0,
  status: 'active', pauseAllowanceDays: 3, pauseUsedDays: 0, pincode: '500001',
  address: 'Old 1', location: cA, stopKey: oldKey, zoneId: zoneA, createdAt: now,
});
const row = (date: string, status: Delivery['status'], extra: Partial<Delivery> = {}): Delivery => ({
  subscriptionId: subId, mobile: M, date, kind: 'cow', litres: 1, pincode: '500001', status, source: 'plan', stopKey: oldKey, ...extra,
});
const ins = await col.deliveries(db).insertMany([
  row(addDaysYMD(today, -2), 'delivered', { deliveredAt: new Date(now.getTime() - 2 * 86400e3), proof: { photoKey: 'photos/it/b9.jpg' } }),
  row(addDaysYMD(today, -1), 'not_delivered', { reason: 'out_of_stock', fault: 'ours', resolution: 'makeup_day' }),
  row(today, 'locked', { snapshot: { name: 'IT Nine', address: 'Old 1', location: cA } }),
  row(tomorrow, 'planned'),
  row(addDaysYMD(today, 2), 'planned'),
]);
const [dDelivered, , dToday, dTomorrow] = Object.values(ins.insertedIds);

// ---- read model ----
const v = await getAccountView(M, ctx);
t('plans section ok', v.plans.ok);
const plan = v.plans.ok ? v.plans.data[0] : undefined;
t('one plan', v.plans.ok && v.plans.data.length === 1);
t('daysLeft counts today..end open rows', plan?.daysLeft === 3);
t('today row locked', plan?.today.rows[0]?.state === 'locked');
t('tomorrow row planned + open', plan?.tomorrow.rows[0]?.state === 'planned' && plan?.tomorrow.closed === false);
t('canRenew with 3 days left and no renewal', plan?.canRenew === true);
t('history has 2 past + today', v.history.ok && v.history.data.length === 3);
const hDel = v.history.ok ? v.history.data.find(h => h.state === 'delivered') : undefined;
t('photo url', hDel?.photoUrl === '/api/photos/photos/it/b9.jpg');
const hMiss = v.history.ok ? v.history.data.find(h => h.state === 'not_delivered') : undefined;
t('miss labelled with resolution', !!hMiss?.resolutionLabel?.includes('make-up'));
t('credits section ok', v.credits.ok);
t('profile name', v.profile.ok && v.profile.data.name === 'IT Nine');

// ---- address: outside any zone ----
await throwsAs(
  'address outside zone rejected',
  () => changeAddress(M, parseAddressInput({ location: { lat: 10, lng: 70 }, addressParts: { house: '1' } }), ctx),
  ValidationError,
);
await throwsAs('address without house rejected', async () => parseAddressInput({ location: cB, addressParts: {} }), ValidationError);

// ---- address: move to zone B ----
const res = await changeAddress(
  M,
  parseAddressInput({ location: cB, addressParts: { house: '12B', society: 'Green Park', pincode: '500002' }, landmark: 'near tank' }),
  ctx,
);
const newKey = stopKeyOf(M, cB);
t('effective from tomorrow', res.effectiveFrom === tomorrow);
t('zone B', res.zoneName === 'it-b9-B');
const sub2 = await col.subscriptions(db).findOne({ _id: subId });
t('plan moved', sub2?.stopKey === newKey && String(sub2?.zoneId) !== String(zoneA) && sub2?.address === '12B, Green Park, 500002');
const today2 = await col.deliveries(db).findOne({ _id: dToday });
t('locked row keeps old stopKey + snapshot', today2?.stopKey === oldKey && today2?.snapshot?.address === 'Old 1');
const tom2 = await col.deliveries(db).findOne({ _id: dTomorrow });
t('planned row gets new stopKey', tom2?.stopKey === newKey && tom2?.pincode === '500002');
const del2 = await col.deliveries(db).findOne({ _id: dDelivered });
t('delivered row untouched', del2?.stopKey === oldKey);
const u2 = await col.users(db).findOne({ mobile: M });
t('profile updated', u2?.landmark === 'near tank' && u2?.location?.lat === cB.lat);
const routes = await col.standingRoutes(db).find({ riderId: { $in: [riderA, riderB] } }).toArray();
t('both riders dirty', routes.length === 2 && routes.every(r => r.dirty));
t('address event', (await col.events(db).countDocuments({ mobile: M, type: 'customer.address_changed' })) === 1);

// ---- preferences ----
const prof = await updatePreferences(M, { whatsappOptIn: true, lang: 'te', missedDeliveryPreference: 'credit' }, ctx);
t('prefs applied', prof.whatsappOptIn && prof.lang === 'te' && prof.missedDeliveryPreference === 'credit');
t('opt-in event', (await col.events(db).countDocuments({ mobile: M, type: 'customer.whatsapp_opt_in' })) === 1);
t('one pref event per field', (await col.events(db).countDocuments({ mobile: M, type: 'customer.preference_changed' })) === 2);
await updatePreferences(M, { lang: 'te' }, ctx);
t('no-op change writes no event', (await col.events(db).countDocuments({ mobile: M, type: 'customer.preference_changed' })) === 2);

// ---- tickets ----
const tk = await reportDeliveryProblem(M, parseTicketInput({ deliveryId: String(dDelivered), kind: 'spoiled', note: 'sour milk' }), ctx);
t('ticket created', tk.status === 'open' && tk.deliveryDate === addDaysYMD(today, -2));
await throwsAs('duplicate open ticket', () => reportDeliveryProblem(M, { deliveryId: dDelivered!, kind: 'other', note: 'again' }, ctx), ConflictError);
await throwsAs('future delivery refused', () => reportDeliveryProblem(M, { deliveryId: dTomorrow!, kind: 'other', note: 'early' }, ctx), ConflictError);
await throwsAs('another customer gets 404', () => reportDeliveryProblem(OTHER, { deliveryId: dDelivered!, kind: 'other', note: 'not mine' }, ctx), NotFoundError);
await throwsAs('short note rejected', async () => parseTicketInput({ deliveryId: String(dDelivered), kind: 'other', note: 'x' }), ValidationError);
const v2 = await getAccountView(M, ctx);
t('ticket in view', v2.tickets.ok && v2.tickets.data.length === 1);
t('timeline has labels', v2.timeline.ok && v2.timeline.data.some(i => i.label === 'Delivery address changed'));

// ---- cleanup ----
await col.deliveries(db).deleteMany({ mobile: { $in: [M, OTHER] } });
await col.subscriptions(db).deleteMany({ mobile: { $in: [M, OTHER] } });
await col.tickets(db).deleteMany({ mobile: { $in: [M, OTHER] } });
await col.events(db).deleteMany({ mobile: { $in: [M, OTHER] } });
await col.users(db).deleteMany({ mobile: { $in: [M, OTHER] } });
await col.zones(db).deleteMany({ name: /^it-b9-/ });
await col.standingRoutes(db).deleteMany({ riderId: { $in: [riderA, riderB] } });
await col.riders(db).deleteMany({ _id: { $in: [riderA, riderB] } });

console.log(`\nb9-account: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
