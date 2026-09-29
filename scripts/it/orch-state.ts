// Integration test: the subscription money/state fixes from the RV-STATE review.
//   MONGODB_DB=maavuli_it_orch pnpm db:init
//   MONGODB_DB=maavuli_it_orch pnpm run it scripts/it/orch-state.ts
//
// Business time is 2031-03-10 10:30 IST (before the 16:00 cutoff) throughout, with
// fresh mobiles per run, so the cases do not depend on each other or on real time.
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, type Subscription } from '@/lib/models';
import { customerActor, type OpCtx } from '@/lib/clock';
import { circleToPolygon } from '@/lib/geo';
import { addDaysYMD } from '@/lib/cutoff';
import { __setRazorpayCreateOrderForTests, createCheckoutOrder, markOrderPaid, type CheckoutInput } from '@/lib/orders';
import { cancelSubscription, extendSubscription, renewalTarget, settleCancellations } from '@/lib/subscriptions';
import { pauseDates } from '@/lib/pause';
import { lockDay } from '@/lib/manifest';
import { ConflictError } from '@/lib/errors';

const db = await getDb();
if (!db.databaseName.startsWith('maavuli_it_')) {
  console.error(`refusing to run against ${db.databaseName} — set MONGODB_DB=maavuli_it_orch`);
  process.exit(2);
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
async function caseRun(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} — threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
}

// ---- fixtures ---------------------------------------------------------------
const CENTRE = { lat: 17.385, lng: 78.4867 };
const PIN = { lat: 17.386, lng: 78.487 };
if (!(await col.zones(db).findOne({ name: 'orch-it-zone' }))) {
  await col.zones(db).insertOne({
    name: 'orch-it-zone',
    active: true,
    shape: { kind: 'circle', centre: CENTRE, radiusM: 3000 },
    geometry: circleToPolygon(CENTRE, 3000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
const freshMobile = () => `93${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const NOW = new Date('2031-03-10T05:00:00Z'); // 10:30 IST
const at = (mobile: string): OpCtx => ({ now: NOW, actor: customerActor(mobile) });

__setRazorpayCreateOrderForTests(async ({ amountPaise, receipt }) => ({
  id: `order_fake_${new ObjectId().toHexString()}`,
  entity: 'order',
  amount: amountPaise,
  currency: 'INR',
  receipt,
  status: 'created',
}));

function input(mobile: string, over: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    mobile,
    purpose: 'new',
    kind: 'cow',
    quantityId: 'one',
    tenureId: '1m',
    details: { name: 'IT Customer', address: 'Flat 1, Test Street, Test Area', location: PIN },
    useCredit: false,
    whatsappOptIn: true,
    idempotencyKey: `orch-${new ObjectId().toHexString()}`,
    ...over,
  };
}
type Sub = Subscription & { _id: ObjectId };
async function buy(mobile: string, over: Partial<CheckoutInput> = {}): Promise<{ orderId: ObjectId; sub: Sub }> {
  const res = await createCheckoutOrder(input(mobile, over), at(mobile));
  await markOrderPaid(res.order._id, { razorpayPaymentId: `pay_fake_${new ObjectId().toHexString()}`, source: 'verify' }, at(mobile));
  return { orderId: res.order._id, sub: await subOf(res.order._id) };
}
async function subOf(orderId: ObjectId): Promise<Sub> {
  const s = await col.subscriptions(db).findOne({ orderId });
  if (!s?._id) throw new Error('no subscription for order');
  return s as Sub;
}
const reload = async (id: ObjectId) => (await col.subscriptions(db).findOne({ _id: id })) as Sub;
const rowsOf = (subscriptionId: ObjectId) =>
  col.deliveries(db).find({ subscriptionId, source: { $in: ['plan', 'makeup'] } }).sort({ date: 1 }).toArray();

// ---- P0-1 · a replayed payment after cancel re-plans nothing -------------------
await caseRun('replayed payment after cancel', async () => {
  const m = freshMobile();
  const { orderId, sub } = await buy(m);
  const c = await cancelSubscription(sub._id, at(m));
  const plannedAfter = async () =>
    col.deliveries(db).countDocuments({ subscriptionId: sub._id, status: 'planned', date: { $gte: c.cancelEffectiveDate } });
  t('cancel removed the future rows', (await plannedAfter()) === 0);
  await markOrderPaid(orderId, { razorpayPaymentId: 'pay_replay', source: 'verify' }, at(m));
  await markOrderPaid(orderId, { razorpayPaymentId: 'pay_replay', source: 'webhook' }, at(m));
  t('replayed verify + webhook re-planned nothing', (await plannedAfter()) === 0, await plannedAfter());

  // defence in depth: a phantom row that slips back in is never locked
  const phantomDate = '2031-12-25';
  await col.deliveries(db).insertOne({
    subscriptionId: sub._id,
    mobile: m,
    date: phantomDate,
    kind: 'cow',
    litres: 1,
    pincode: sub.pincode,
    status: 'planned',
    source: 'plan',
    updatedAt: NOW,
  });
  await lockDay(phantomDate, at(m));
  const phantom = await col.deliveries(db).findOne({ subscriptionId: sub._id, date: phantomDate });
  t('lock skips a cancelled plan’s row after its effective date', phantom?.status === 'planned', phantom?.status);

  let refused = false;
  try {
    await extendSubscription(sub._id, 1, 'makeup', at(m));
  } catch (e) {
    refused = e instanceof ConflictError;
  }
  t('extend refuses a cancelled plan', refused);
});

// ---- P0-2 · a refund that fails at cancel is settled by the tick ---------------
await caseRun('refund retried by the tick', async () => {
  const m = freshMobile();
  const { orderId, sub } = await buy(m);
  // make the refund side fail once: breakdownFor cannot find the order
  await col.subscriptions(db).updateOne({ _id: sub._id }, { $set: { orderId: new ObjectId() } });
  const c = await cancelSubscription(sub._id, at(m));
  t('cancel still succeeds', c.status === 'cancelled');
  let s = await reload(sub._id);
  t('refund marked pending', s.refundPending === true);
  t('no refund row yet', (await col.refunds(db).countDocuments({ subscriptionId: sub._id })) === 0);
  t('no confirmation sent yet (it would say ₹0)', (await col.outbox(db).countDocuments({ dedupeKey: `cancel:${sub._id.toHexString()}` })) === 0);

  await col.subscriptions(db).updateOne({ _id: sub._id }, { $set: { orderId } });
  const r1 = await settleCancellations(at(m));
  t('tick settled it', r1.settled >= 1, r1);
  s = await reload(sub._id);
  const refund = await col.refunds(db).findOne({ subscriptionId: sub._id });
  t('refund row created for the unused days', !!refund && refund.amountPaise > 0, refund?.amountPaise);
  t('pending flag cleared, settled time set', s.refundPending === undefined && !!s.refundSettledAt);
  t('subscription points at the refund', !!refund?._id && s.refundId?.equals(refund._id) === true);
  const msgs = await col.outbox(db).find({ dedupeKey: `cancel:${sub._id.toHexString()}` }).toArray();
  t('one confirmation, with the real amount', msgs.length === 1 && !/^₹0$/.test(String(msgs[0]?.params?.refund)), msgs.map(x => x.params));

  await settleCancellations(at(m));
  await cancelSubscription(sub._id, at(m));
  t('settling again is a no-op', (await col.refunds(db).countDocuments({ subscriptionId: sub._id })) === 1);
});

// ---- P2-17 · P2-12 · P1-3 · renewal chains ------------------------------------
await caseRun('renewal chain', async () => {
  const m = freshMobile();
  const A = (await buy(m)).sub;
  // two renewals checked out before either is paid ("UPI pending, pay again")
  const b = await createCheckoutOrder(input(m, { purpose: 'renewal', renewsSubscriptionId: A._id }), at(m));
  const c = await createCheckoutOrder(input(m, { purpose: 'renewal', renewsSubscriptionId: A._id }), at(m));
  await markOrderPaid(b.order._id, { razorpayPaymentId: 'pay_b', source: 'verify' }, at(m));
  await markOrderPaid(c.order._id, { razorpayPaymentId: 'pay_c', source: 'verify' }, at(m));
  let B = await subOf(b.order._id);
  let C = await subOf(c.order._id);
  t('B starts the day after A', B.startDate === addDaysYMD(A.endDate, 1), [A.endDate, B.startDate]);
  t('C stacks after B instead of overlapping it', C.startDate === addDaysYMD(B.endDate, 1), [B.endDate, C.startDate]);
  t('chain linked A→B→C', (await reload(A._id)).renewedBy?.equals(B._id) === true && (await reload(B._id)).renewedBy?.equals(C._id) === true);

  // B's pause is a calendar day and must survive a shift
  const pausedDay = addDaysYMD(B.startDate, 3);
  await pauseDates(B._id, [pausedDay], at(m));
  B = await reload(B._id);
  const bRowsBefore = (await rowsOf(B._id)).length;
  await extendSubscription(A._id, 1, 'makeup', at(m));
  B = await reload(B._id);
  C = await reload(C._id);
  const bRows = await rowsOf(B._id);
  t('B moved one day on', B.startDate === addDaysYMD((await reload(A._id)).endDate, 1), B.startDate);
  t('B still has no delivery on its paused day', !bRows.some(r => r.date === pausedDay));
  t('B kept its row count', bRows.length === bRowsBefore, [bRows.length, bRowsBefore]);
  t('B ends on its last row', B.endDate === bRows[bRows.length - 1]?.date, [B.endDate, bRows[bRows.length - 1]?.date]);
  t('C moved with B (no overlap)', C.startDate === addDaysYMD(B.endDate, 1), [B.endDate, C.startDate]);

  // cancelling the last renewal frees B to be renewed again
  await cancelSubscription(C._id, at(m));
  t('cancelled renewal unlinks', (await reload(B._id)).renewedBy === undefined);
  t('B is renewable again', (await renewalTarget(m, B._id, at(m))) !== null);

  // cancelling A pulls the paid renewal forward to where A stops
  const cancelA = await cancelSubscription(A._id, at(m));
  B = await reload(B._id);
  const bRowsAfter = await rowsOf(B._id);
  t('B pulled forward to A’s stop date', B.startDate === cancelA.cancelEffectiveDate, [cancelA.cancelEffectiveDate, B.startDate]);
  t('B’s first delivery is on that date', bRowsAfter[0]?.date === cancelA.cancelEffectiveDate, bRowsAfter[0]?.date);
  t('B kept its row count after moving back', bRowsAfter.length === bRowsBefore, [bRowsAfter.length, bRowsBefore]);
  t('B’s paused day still has no delivery', !bRowsAfter.some(r => r.date === pausedDay));
});

// ---- P2-13 · two extends at once both count ----------------------------------
await caseRun('concurrent extends', async () => {
  const m = freshMobile();
  const { sub } = await buy(m);
  await Promise.all([extendSubscription(sub._id, 1, 'makeup', at(m)), extendSubscription(sub._id, 1, 'makeup', at(m))]);
  const s = await reload(sub._id);
  const makeups = await col.deliveries(db).countDocuments({ subscriptionId: sub._id, source: 'makeup' });
  t('end moved by two days', s.endDate === addDaysYMD(sub.endDate, 2), [sub.endDate, s.endDate]);
  t('two make-up rows', makeups === 2, makeups);
});

// ---- P2-16 · a redelivered webhook on a refunded order acknowledges ----------
await caseRun('webhook on a refunded order', async () => {
  const m = freshMobile();
  const { orderId } = await buy(m);
  await col.orders(db).updateOne({ _id: orderId }, { $set: { status: 'refunded' } });
  let threw: unknown = null;
  try {
    await markOrderPaid(orderId, { razorpayPaymentId: 'pay_again', source: 'webhook' }, at(m));
  } catch (e) {
    threw = e;
  }
  t('no throw (no 500 loop)', threw === null, threw instanceof Error ? threw.message : threw);
});

console.log(`orch-state: ${passed} passed, ${failed} failed · db=${db.databaseName}`);
process.exit(failed ? 1 : 0);
