// B1 integration test: subscription & order lifecycle against a real, isolated Mongo.
//
//   MONGODB_DB=maavuli_it_b1 pnpm db:init
//   MONGODB_DB=maavuli_it_b1 pnpm it scripts/it/b1-lifecycle.ts
//
// Every lib call gets an explicit ctx.now (2030 dates, far from real time) so the
// cutoff arithmetic is exercised deterministically. Fresh mobiles per run.
// A case whose dependency (another owner's module) still throws 'not implemented'
// is reported NOT VERIFIED, never PASS.
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, type Subscription } from '@/lib/models';
import { customerActor, type OpCtx } from '@/lib/clock';
import { circleToPolygon } from '@/lib/geo';
import { addDaysYMD, istYMD } from '@/lib/cutoff';
import { addCredit, creditBalance } from '@/lib/credits';
import {
  __setRazorpayCreateOrderForTests,
  createCheckoutOrder,
  expireUnpaidOrders,
  markOrderPaid,
  type CheckoutInput,
} from '@/lib/orders';
import {
  activateDueSubscriptions,
  cancelSubscription,
  extendSubscription,
} from '@/lib/subscriptions';
import { pauseDates, unpauseDates } from '@/lib/pause';
import { DateLockedError, ConflictError } from '@/lib/errors';

const db = await getDb();
if (!db.databaseName.startsWith('maavuli_it_')) {
  console.error(`refusing to run against ${db.databaseName} — set MONGODB_DB=maavuli_it_b1`);
  process.exit(2);
}

let pass = 0;
let fail = 0;
let nv = 0;
const results: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else fail++;
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function notVerified(name: string, why: string): void {
  nv++;
  results.push(`NOT VERIFIED  ${name} — ${why}`);
}
const isNotImpl = (e: unknown) => e instanceof Error && /not implemented/.test(e.message);
async function caseRun(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (isNotImpl(e)) notVerified(name, (e as Error).message);
    else {
      fail++;
      results.push(`FAIL  ${name} — threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
  }
}

// ---- fixtures ---------------------------------------------------------------
const CENTRE = { lat: 17.385, lng: 78.4867 };
const PIN = { lat: 17.386, lng: 78.487 };
if (!(await col.zones(db).findOne({ name: 'b1-it-zone' }))) {
  await col.zones(db).insertOne({
    name: 'b1-it-zone',
    active: true,
    shape: { kind: 'circle', centre: CENTRE, radiusM: 3000 },
    geometry: circleToPolygon(CENTRE, 3000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
const freshMobile = () => `91${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const key = () => `b1it-${new ObjectId().toHexString()}`;

// 2030-01-10 IST: 10:30 (before the 16:00 cutoff) and 16:30 (after)
const BEFORE = new Date('2030-01-10T05:00:00Z');
const AFTER = new Date('2030-01-10T11:00:00Z');
const at = (now: Date, mobile: string): OpCtx => ({ now, actor: customerActor(mobile) });

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
    kind: 'buffalo',
    quantityId: 'half',
    tenureId: '1m',
    details: { name: 'IT Customer', address: 'Flat 1, Test Street, Test Area', location: PIN },
    useCredit: false,
    whatsappOptIn: true,
    idempotencyKey: key(),
    ...over,
  };
}
async function subFor(orderId: ObjectId): Promise<Subscription & { _id: ObjectId }> {
  const s = await col.subscriptions(db).findOne({ orderId });
  if (!s?._id) throw new Error('no subscription for order');
  return s as Subscription & { _id: ObjectId };
}
const planRows = (subscriptionId: ObjectId) =>
  col.deliveries(db).find({ subscriptionId, source: { $in: ['plan', 'makeup'] } }).sort({ date: 1 }).toArray();

const mA = freshMobile();
const mB = freshMobile();
let subA: (Subscription & { _id: ObjectId }) | null = null;
let subB: (Subscription & { _id: ObjectId }) | null = null;

// ---- 1. start date before cutoff (Razorpay path, verify) -----------------------
await caseRun('start before cutoff → first open = tomorrow, scheduled, 30 planned plan rows', async () => {
  const ctx = at(BEFORE, mA);
  const res = await createCheckoutOrder(input(mA), ctx);
  ok('checkout returns razorpay order', res.razorpay !== null && res.order.status === 'created');
  await markOrderPaid(res.order._id, { razorpayPaymentId: 'pay_fake_a', source: 'verify' }, ctx);
  subA = await subFor(res.order._id);
  const rows = await planRows(subA._id);
  ok('A.startDate = 2030-01-11', subA.startDate === '2030-01-11', subA.startDate);
  ok('A.endDate = 2030-02-09', subA.endDate === '2030-02-09', subA.endDate);
  ok('A status scheduled', subA.status === 'scheduled', subA.status);
  ok('A 30 planned/plan rows', rows.length === 30 && rows.every(r => r.status === 'planned' && r.source === 'plan'), String(rows.length));
  ok('A stopKey + zoneId set', !!subA.stopKey && !!subA.zoneId);
  const outbox = await col.outbox(db).countDocuments({ dedupeKey: `order_confirmed:${res.order._id.toHexString()}` });
  ok('order_confirmed enqueued once', outbox === 1, String(outbox));
  // re-running payment is a no-op
  await markOrderPaid(res.order._id, { razorpayPaymentId: 'pay_fake_a', source: 'webhook' }, ctx);
  ok('markOrderPaid idempotent (still 30 rows, one sub)', (await planRows(subA._id)).length === 30 &&
    (await col.subscriptions(db).countDocuments({ orderId: res.order._id })) === 1);
  const act = await activateDueSubscriptions(at(new Date('2030-01-11T01:00:00Z'), mA));
  const a2 = await col.subscriptions(db).findOne({ _id: subA._id });
  ok('tick activates A on its start date', act.activated >= 1 && a2?.status === 'active', a2?.status);
});

// ---- 2. start date after cutoff ------------------------------------------------
await caseRun('start after cutoff → first open = day after tomorrow', async () => {
  const ctx = at(AFTER, mB);
  const res = await createCheckoutOrder(input(mB, { kind: 'cow', quantityId: 'one' }), ctx);
  await markOrderPaid(res.order._id, { razorpayPaymentId: 'pay_fake_b', source: 'verify' }, ctx);
  subB = await subFor(res.order._id);
  ok('B.startDate = 2030-01-12', subB.startDate === '2030-01-12', subB.startDate);
});
await caseRun('startDate > 30 days out → ValidationError', async () => {
  try {
    await createCheckoutOrder(input(mB, { startDate: '2030-03-01' }), at(AFTER, mB));
    ok('startDate > 30 days out → ValidationError', false, 'accepted');
  } catch (e) {
    ok('startDate > 30 days out → ValidationError', e instanceof Error && e.name === 'ValidationError', String(e));
  }
});
// ---- 3. idempotent checkout (credit-only path) ----------------------------------
await caseRun('idempotent checkout (credit-only)', async () => {
  const m = freshMobile();
  const ctx = at(BEFORE, m);
  await col.users(db).updateOne({ mobile: m }, { $setOnInsert: { mobile: m, createdAt: BEFORE } }, { upsert: true });
  await addCredit({ mobile: m, amountPaise: 200_000, kind: 'goodwill', refundable: false, note: 'b1 it' }, ctx);
  const k = key();
  const r1 = await createCheckoutOrder(input(m, { useCredit: true, idempotencyKey: k }), ctx);
  const r2 = await createCheckoutOrder(input(m, { useCredit: true, idempotencyKey: k }), ctx);
  ok('credit-only: razorpay null, paid, credit_<hex> id', r1.razorpay === null && r1.order.status === 'paid' && /^credit_[0-9a-f]{24}$/.test(r1.order.razorpayOrderId), r1.order.razorpayOrderId);
  ok('same key → same order', r1.order._id.equals(r2.order._id));
  const bal = await creditBalance(m);
  ok('credit spent exactly once (200000 − 142500)', bal.balancePaise === 57_500, String(bal.balancePaise));
  ok('one subscription for the order', (await col.subscriptions(db).countDocuments({ orderId: r1.order._id })) === 1);
  try {
    await createCheckoutOrder(input(m, { useCredit: true, idempotencyKey: k, tenureId: '3m' }), ctx);
    ok('same key, different payload → ConflictError', false, 'accepted');
  } catch (e) {
    ok('same key, different payload → ConflictError', e instanceof ConflictError, String(e));
  }
  try {
    await createCheckoutOrder(input(freshMobile(), { idempotencyKey: k }), ctx);
    ok('same key, other mobile → ConflictError', false, 'accepted');
  } catch (e) {
    ok('same key, other mobile → ConflictError', e instanceof ConflictError, String(e));
  }
  try {
    await createCheckoutOrder(input(m, { details: { name: 'X Y', address: 'Somewhere far away', location: { lat: 12.97, lng: 77.59 } } }), ctx);
    ok('pin outside every zone → ValidationError', false, 'accepted');
  } catch (e) {
    ok('pin outside every zone → ValidationError', e instanceof Error && e.name === 'ValidationError', String(e));
  }
});

// ---- 4. renewal chain + extension shift ------------------------------------------
let renewal: (Subscription & { _id: ObjectId }) | null = null;
await caseRun('renewal chain + extension shift', async () => {
  if (!subA) throw new Error('case 1 did not produce subA');
  const ctx = at(BEFORE, mA);
  const res = await createCheckoutOrder(input(mA, { purpose: 'renewal', renewsSubscriptionId: subA._id }), ctx);
  await markOrderPaid(res.order._id, { razorpayPaymentId: 'pay_fake_r', source: 'verify' }, ctx);
  renewal = await subFor(res.order._id);
  const a = (await col.subscriptions(db).findOne({ _id: subA._id }))!;
  ok('renewal starts day after A ends', renewal.startDate === addDaysYMD(a.endDate, 1), `${renewal.startDate} vs A.end ${a.endDate}`);
  ok('linked renewedBy / renewalOf', a.renewedBy?.equals(renewal._id) === true && renewal.renewalOf?.equals(subA._id) === true);
  try {
    await createCheckoutOrder(input(mA, { purpose: 'renewal', renewsSubscriptionId: subA._id }), ctx);
    ok('second renewal of A refused', false, 'accepted');
  } catch (e) {
    ok('second renewal of A refused', e instanceof Error && e.name === 'ValidationError', String(e));
  }
  const before = renewal.startDate;
  const { newEndDate, appended } = await extendSubscription(subA._id, 2, 'makeup', ctx);
  const r2 = (await col.subscriptions(db).findOne({ _id: renewal._id }))!;
  const rRows = await planRows(renewal._id);
  ok('A extended by 2 makeup days', newEndDate === addDaysYMD(a.endDate, 2) && appended.length === 2, newEndDate);
  ok('renewal shifted by 2', r2.startDate === addDaysYMD(before, 2) && rRows[0]?.date === r2.startDate, `${r2.startDate} first row ${rRows[0]?.date}`);
  ok('renewal still has 30 rows, no overlap with A', rRows.length === 30 && rRows[0]!.date > newEndDate);
  renewal = r2 as Subscription & { _id: ObjectId };
});

// ---- 5. pause / unpause symmetry -------------------------------------------------
await caseRun('pause / unpause symmetry (incl. renewal shift back)', async () => {
  if (!subA || !renewal) throw new Error('needs cases 1 and 4');
  const ctx = at(BEFORE, mA);
  const a0 = (await col.subscriptions(db).findOne({ _id: subA._id }))!;
  const r0 = (await col.subscriptions(db).findOne({ _id: renewal._id }))!;
  const rows0 = (await planRows(subA._id)).length;
  const dates = ['2030-01-15', '2030-01-16'];
  const p = await pauseDates(subA._id, dates, ctx);
  const a1 = (await col.subscriptions(db).findOne({ _id: subA._id }))!;
  const r1 = (await col.subscriptions(db).findOne({ _id: renewal._id }))!;
  ok('pause: endDate +2', p.newEndDate === addDaysYMD(a0.endDate, 2) && a1.endDate === p.newEndDate, a1.endDate);
  ok('pause: same number of deliveries', (await planRows(subA._id)).length === rows0);
  ok('pause: no rows on paused dates', (await col.deliveries(db).countDocuments({ subscriptionId: subA._id, date: { $in: dates } })) === 0);
  ok('pause: allowance used 2', a1.pauseUsedDays === a0.pauseUsedDays + 2);
  ok('pause: renewal shifted +2', r1.startDate === addDaysYMD(r0.startDate, 2), r1.startDate);
  ok('pause_confirmed enqueued', (await col.outbox(db).countDocuments({ dedupeKey: `pause:${subA._id.toHexString()}:2030-01-15:2` })) === 1);
  const again = await pauseDates(subA._id, dates, ctx);
  ok('pause idempotent', again.newEndDate === a1.endDate);
  try {
    await pauseDates(subA._id, ['2030-01-10'], ctx);
    ok('pause of a closed date → DateLockedError', false, 'accepted');
  } catch (e) {
    ok('pause of a closed date → DateLockedError', e instanceof DateLockedError, String(e));
  }
  const u = await unpauseDates(subA._id, dates, ctx);
  const a2 = (await col.subscriptions(db).findOne({ _id: subA._id }))!;
  const r2 = (await col.subscriptions(db).findOne({ _id: renewal._id }))!;
  ok('unpause: endDate restored', u.newEndDate === a0.endDate && a2.endDate === a0.endDate, a2.endDate);
  ok('unpause: rows restored on the dates', (await col.deliveries(db).countDocuments({ subscriptionId: subA._id, date: { $in: dates }, status: 'planned' })) === 2);
  ok('unpause: same number of deliveries', (await planRows(subA._id)).length === rows0);
  ok('unpause: allowance returned', a2.pauseUsedDays === a0.pauseUsedDays);
  ok('unpause: renewal shifted back', r2.startDate === r0.startDate, r2.startDate);
});

// ---- 6. extension of a plan that ended yesterday -------------------------------
await caseRun('extend a plan whose endDate is yesterday → row on first open date, not today', async () => {
  const m = freshMobile();
  const ctx = at(BEFORE, m);
  const res = await createCheckoutOrder(input(m), ctx);
  await markOrderPaid(res.order._id, { source: 'verify', razorpayPaymentId: 'pay_fake_y' }, ctx);
  const s = await subFor(res.order._id);
  // Later: 2030-02-20 10:30 IST, plan ended 2030-02-19 (yesterday)
  const later = new Date('2030-02-20T05:00:00Z');
  await col.subscriptions(db).updateOne({ _id: s._id }, { $set: { endDate: '2030-02-19' } });
  const { appended, newEndDate } = await extendSubscription(s._id, 1, 'makeup', at(later, m));
  ok('appended on first open date 2030-02-21', appended.length === 1 && appended[0] === '2030-02-21', appended.join(','));
  ok('not on today', !appended.includes(istYMD(later)));
  ok('endDate = last appended date', newEndDate === '2030-02-21', newEndDate);
});

// ---- 7. cancel counts a locked day ------------------------------------------------
await caseRun('cancel keeps a locked day (charged) and deletes open planned days', async () => {
  if (!subB) throw new Error('case 2 did not produce subB');
  // now: 2030-01-12 17:00 IST → 2030-01-13 is past cutoff; first open = 2030-01-14
  const now = new Date('2030-01-12T11:30:00Z');
  const ctx = at(now, mB);
  await col.deliveries(db).updateMany({ subscriptionId: subB._id, date: { $in: ['2030-01-12', '2030-01-13'] } }, { $set: { status: 'locked' } });
  await col.deliveries(db).updateOne({ subscriptionId: subB._id, date: '2030-01-12' }, { $set: { status: 'delivered' } });
  const res = await cancelSubscription(subB._id, ctx, { reason: 'b1 it' });
  const s = (await col.subscriptions(db).findOne({ _id: subB._id }))!;
  const left = await col.deliveries(db).find({ subscriptionId: subB._id }).toArray();
  ok('effective date = first open 2030-01-14', res.cancelEffectiveDate === '2030-01-14', res.cancelEffectiveDate);
  ok('status cancelled + cancelledBy + reason', s.status === 'cancelled' && s.cancelledBy?.id === mB && s.cancelReason === 'b1 it');
  ok('delivered + locked rows kept, 28 planned deleted', left.length === 2 && res.daysRemaining === 28, `${left.length} left, ${res.daysRemaining} removed`);
  ok('cancellation_confirmed enqueued', (await col.outbox(db).countDocuments({ dedupeKey: `cancel:${subB._id.toHexString()}` })) === 1);
  const refund = await col.refunds(db).findOne({ subscriptionId: subB._id });
  if (!refund) notVerified('refund counts the locked day as charged', 'no refund row (lib/refunds createCancellationRefund not implemented yet or threw — see log)');
  else ok('refund counts the locked day as charged (chargedDays = 2)', refund.breakdown.chargedDays === 2, String(refund.breakdown.chargedDays));
  const again = await cancelSubscription(subB._id, ctx);
  ok('cancel idempotent', again.status === 'cancelled' && again.daysRemaining === 0);
});

// ---- 8. expiry reverses credit -------------------------------------------------------
await caseRun('unpaid order expiry reverses the credit spend', async () => {
  const m = freshMobile();
  const ctx = at(BEFORE, m);
  await col.users(db).updateOne({ mobile: m }, { $setOnInsert: { mobile: m, createdAt: BEFORE } }, { upsert: true });
  await addCredit({ mobile: m, amountPaise: 50_000, kind: 'goodwill', refundable: false }, ctx);
  const res = await createCheckoutOrder(input(m, { useCredit: true }), ctx);
  ok('partial credit applied, remainder via Razorpay', res.order.creditAppliedPaise === 50_000 && res.razorpay?.amountPaise === 92_500);
  ok('balance 0 after spend', (await creditBalance(m)).balancePaise === 0);
  const early = await expireUnpaidOrders(at(new Date(BEFORE.getTime() + 10 * 60_000), m));
  const o1 = await col.orders(db).findOne({ _id: res.order._id });
  ok('not expired before unpaidOrderExpiryMinutes', o1?.status === 'created', `${o1?.status} (${early.expired})`);
  await expireUnpaidOrders(at(new Date(BEFORE.getTime() + 31 * 60_000), m));
  const o2 = await col.orders(db).findOne({ _id: res.order._id });
  ok('expired after 30 min', o2?.status === 'expired', o2?.status);
  ok('credit restored', (await creditBalance(m)).balancePaise === 50_000);
  await expireUnpaidOrders(at(new Date(BEFORE.getTime() + 62 * 60_000), m));
  ok('reversal idempotent', (await creditBalance(m)).balancePaise === 50_000);
});

__setRazorpayCreateOrderForTests(undefined);
console.log(results.join('\n'));
console.log(`\nb1-lifecycle: ${pass} passed, ${fail} failed, ${nv} not verified · db=${db.databaseName}`);
process.exit(fail ? 1 : 0);
