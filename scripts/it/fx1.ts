// Integration test: FX1 money fixes from RV-STATE / RV-SEC.
//   MONGODB_DB=maavuli_it_fx1 pnpm -s db:init
//   MONGODB_DB=maavuli_it_fx1 pnpm -s run it scripts/it/fx1.ts
//
// Business time is fixed (2031-05-10 10:30 IST, before the 16:00 cutoff); fresh
// mobiles per run. Razorpay is never reached: orders use __setRazorpayCreateOrderForTests,
// refunds use __setRazorpayRefundsForTests, and any other fetch to Razorpay throws.
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, type Order, type Subscription } from '@/lib/models';
import { customerActor, staffActor, systemCtx, type OpCtx } from '@/lib/clock';
import { circleToPolygon } from '@/lib/geo';
import { addDaysYMD, istYMD } from '@/lib/cutoff';
import { extendSubscription } from '@/lib/subscriptions';
import { addCredit, creditBalance, spendCredit } from '@/lib/credits';
import {
  __setRazorpayCreateOrderForTests,
  createCheckoutOrder,
  expireUnpaidOrders,
  markOrderPaid,
  repairPaidOrders,
  type CheckoutInput,
} from '@/lib/orders';
import { activateExtraOrder, createExtraOrder } from '@/lib/extras';
import { compensateMissedDelivery, reverseCompensation } from '@/lib/compensation';
import { markDelivered, markNotDelivered, setFault } from '@/lib/outcomes';
import { createCancellationRefund, handleRazorpayRefundEvent, processRefund, recordManualRefund, setRefundUpi } from '@/lib/refunds';
import { __setRazorpayRefundsForTests, type RazorpayRefund } from '@/lib/razorpay';
import { ConflictError, ValidationError } from '@/lib/errors';

const db = await getDb();
if (!db.databaseName.startsWith('maavuli_it_')) {
  console.error(`refusing to run against ${db.databaseName} — set MONGODB_DB=maavuli_it_fx1`);
  process.exit(2);
}
for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) process.env[k] ||= `it_${k.toLowerCase()}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('razorpay.com')) throw new Error('IT: live Razorpay call blocked');
  return realFetch(input, init);
}) as typeof fetch;

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
async function threw<T>(p: Promise<T>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

// ---- fixtures ---------------------------------------------------------------
const CENTRE = { lat: 17.385, lng: 78.4867 };
const PIN = { lat: 17.386, lng: 78.487 };
if (!(await col.zones(db).findOne({ name: 'fx1-it-zone' }))) {
  await col.zones(db).insertOne({
    name: 'fx1-it-zone',
    active: true,
    shape: { kind: 'circle', centre: CENTRE, radiusM: 3000 },
    geometry: circleToPolygon(CENTRE, 3000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
const freshMobile = () => `94${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const NOW = new Date('2031-05-10T05:00:00Z'); // 10:30 IST
const TODAY = istYMD(NOW);
const at = (mobile: string, now = NOW): OpCtx => ({ now, actor: customerActor(mobile) });
const staff: OpCtx = { now: NOW, actor: staffActor('9000000001') };
const sys: OpCtx = systemCtx(NOW, 'it_fx1');

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
    idempotencyKey: `fx1-${new ObjectId().toHexString()}`,
    ...over,
  };
}
async function user(mobile: string, extra: Record<string, unknown> = {}): Promise<void> {
  await col.users(db).updateOne({ mobile }, { $set: extra, $setOnInsert: { mobile, createdAt: NOW } }, { upsert: true });
}
async function planOrder(mobile: string, extra: Partial<Order> = {}): Promise<ObjectId> {
  return (
    await col.orders(db).insertOne({
      razorpayOrderId: `order_it_${new ObjectId().toHexString()}`,
      mobile, purpose: 'new', kind: 'cow', quantityId: 'one', tenureId: '1y',
      amountPaise: 3_519_000, perLitrePaise: 9_775, days: 360, litres: 360, pincode: '500001',
      status: 'paid', createdAt: NOW, paidAt: NOW, ...extra,
    })
  ).insertedId;
}
async function subDoc(mobile: string, orderId: ObjectId, extra: Partial<Subscription> = {}): Promise<ObjectId> {
  return (
    await col.subscriptions(db).insertOne({
      orderId, mobile, kind: 'cow', qtyNum: 1, qtyDen: 1, startDate: '2031-05-01', endDate: '2031-06-30',
      daysTotal: 61, daysDelivered: 0, daysPaused: 0, status: 'active', pauseAllowanceDays: 3, pauseUsedDays: 0,
      pincode: '500001', createdAt: NOW, ...extra,
    })
  ).insertedId;
}
async function missed(mobile: string, subscriptionId: ObjectId, date: string, extra: Record<string, unknown> = {}): Promise<ObjectId> {
  return (
    await col.deliveries(db).insertOne({
      subscriptionId, mobile, date, kind: 'cow', litres: 1, pincode: '500001',
      status: 'not_delivered', source: 'plan', reason: 'out_of_stock', fault: 'ours', ...extra,
    })
  ).insertedId;
}

/** 60 delivered days (₹28,290 of a ₹35,190 1-year plan stays refundable, as in contract §4). */
async function charged(mobile: string, subscriptionId: ObjectId): Promise<void> {
  const days = Array.from({ length: 60 }, (_, i) => addDaysYMD('2031-01-01', i));
  await col.deliveries(db).insertMany(
    days.map(date => ({ subscriptionId, mobile, date, kind: 'cow' as const, litres: 1, pincode: '500001', status: 'delivered' as const, source: 'plan' as const })),
  );
}

/** Razorpay stand-in: `lose` makes create succeed at Razorpay but lose the response. */
function fakeRefunds(opts: { lose: boolean; status: RazorpayRefund['status'] }) {
  const store: RazorpayRefund[] = [];
  const state = { creates: 0, lose: opts.lose };
  __setRazorpayRefundsForTests({
    create: async ({ paymentId, amountPaise, receipt, notes }) => {
      state.creates++;
      const rz: RazorpayRefund = {
        id: `rfnd_${new ObjectId().toHexString()}`,
        amount: amountPaise,
        payment_id: paymentId,
        status: opts.status,
        receipt: receipt ?? null,
        ...(notes ? { notes } : {}),
      } as RazorpayRefund;
      store.push(rz);
      if (state.lose) throw new Error('ETIMEDOUT');
      return rz;
    },
    list: async paymentId => store.filter(r => r.payment_id === paymentId),
  });
  return { store, state };
}

// ---- P1-1 · a retry after a lost Razorpay answer adopts the existing refund ----
await caseRun('P1-1 retry adopts', async () => {
  const m = freshMobile();
  await user(m);
  const oid = await planOrder(m, { razorpayPaymentId: `pay_fx1a${Date.now()}`, paidAt: new Date(NOW.getTime() - 86_400_000) });
  const sid = await subDoc(m, oid, { status: 'cancelled', cancelEffectiveDate: TODAY });
  const rz = fakeRefunds({ lose: true, status: 'processed' });
  const r = await createCancellationRefund(sid, sys);
  t('P1-1 lost answer → failed', r?.status === 'failed', r?.status);
  rz.state.lose = false;
  const again = await processRefund(r!._id!, staff);
  t('P1-1 retry created no second Razorpay refund', rz.state.creates === 1, rz.state.creates);
  t('P1-1 retry settles processed', again.status === 'processed', again.status);
  const o = await col.orders(db).findOne({ _id: oid });
  t('P1-1 order refundedPaise counted once', o?.refundedPaise === r!.amountPaise, [o?.refundedPaise, r?.amountPaise]);
});

await caseRun('P1-1 late webhook settles a failed row', async () => {
  const m = freshMobile();
  await user(m);
  const pay = `pay_fx1b${Date.now()}`;
  const oid = await planOrder(m, { razorpayPaymentId: pay, paidAt: new Date(NOW.getTime() - 86_400_000) });
  const sid = await subDoc(m, oid, { status: 'cancelled', cancelEffectiveDate: TODAY });
  const rz = fakeRefunds({ lose: true, status: 'pending' });
  const r = await createCancellationRefund(sid, sys);
  t('P1-1b failed first', r?.status === 'failed', r?.status);
  const made = rz.store[0]!;
  await handleRazorpayRefundEvent('refund.processed', { id: made.id, payment_id: pay, amount: made.amount, notes: made.notes ?? {} }, sys);
  const after = await col.refunds(db).findOne({ _id: r!._id! });
  t('P1-1b webhook moved failed → processed', after?.status === 'processed' && after.razorpayRefundId === made.id, after?.status);
  const o = await col.orders(db).findOne({ _id: oid });
  t('P1-1b order refunded', o?.refundedPaise === r!.amountPaise && o?.status === 'refunded', [o?.refundedPaise, o?.status]);
});
__setRazorpayRefundsForTests(null);

// ---- SEC-8 · manual UPI payout defaults to the customer's id -----------------
await caseRun('SEC-8 manual refund UPI', async () => {
  const m = freshMobile();
  await user(m);
  const oid = await planOrder(m, { paidAt: new Date(NOW.getTime() - 200 * 86_400_000) });
  const sid = await subDoc(m, oid, { status: 'cancelled', cancelEffectiveDate: TODAY });
  const r = await createCancellationRefund(sid, sys);
  t('SEC-8 parked awaiting_upi', r?.status === 'awaiting_upi', r?.status);
  const id = r!._id!;
  const e1 = await threw(recordManualRefund(id, { utr: 'UTR00011122' }, staff));
  t('SEC-8 no saved UPI, none given → upi_required', e1 instanceof ValidationError && e1.code === 'upi_required', e1 instanceof Error ? e1.message : e1);
  await setRefundUpi(id, m, 'ravi@okaxis', at(m));
  const e2 = await threw(recordManualRefund(id, { utr: 'UTR00011122', upiId: 'someone@okhdfc' }, staff));
  t('SEC-8 different UPI without reason → upi_override_reason', e2 instanceof ValidationError && e2.code === 'upi_override_reason');
  const e3 = await threw(recordManualRefund(id, { utr: 'UTR00011122', upiId: 'someone@okhdfc', reason: 'no' }, staff));
  t('SEC-8 reason under 5 chars refused', e3 instanceof ValidationError && e3.code === 'upi_override_reason');
  const done = await recordManualRefund(id, { utr: 'UTR00011122', upiId: 'someone@okhdfc', reason: 'customer asked on call' }, staff);
  t('SEC-8 override with reason pays', done.status === 'paid_manually' && done.upiId === 'someone@okhdfc');
  const ev = await col.events(db).findOne({ entityId: id.toHexString(), type: 'refund.paid_manually' });
  t(
    'SEC-8 event records override + customer id + reason',
    ev?.data?.upiOverridden === true && ev.data.customerUpiId === 'ravi@okaxis' && ev.data.reason === 'customer asked on call',
    ev?.data,
  );
  const replay = await recordManualRefund(id, { utr: 'UTR00011122' }, staff);
  t('SEC-8 same-UTR replay idempotent', replay.status === 'paid_manually' && (await col.events(db).countDocuments({ entityId: id.toHexString(), type: 'refund.paid_manually' })) === 1);

  // default path: upiId omitted pays the saved one, not overridden
  const m2 = freshMobile();
  await user(m2);
  const oid2 = await planOrder(m2, { paidAt: new Date(NOW.getTime() - 200 * 86_400_000) });
  const sid2 = await subDoc(m2, oid2, { status: 'cancelled', cancelEffectiveDate: TODAY });
  const r2 = await createCancellationRefund(sid2, sys);
  await setRefundUpi(r2!._id!, m2, 'asha@okicici', at(m2));
  const d2 = await recordManualRefund(r2!._id!, { utr: 'UTR99988877' }, staff);
  const ev2 = await col.events(db).findOne({ entityId: r2!._id!.toHexString(), type: 'refund.paid_manually' });
  t('SEC-8 omitted upiId pays the customer’s', d2.upiId === 'asha@okicici' && ev2?.data?.upiOverridden === false, ev2?.data);
});

// ---- SEC-8 · outcome note capped at 500 --------------------------------------
await caseRun('SEC-8 note cap', async () => {
  const m = freshMobile();
  await user(m);
  const sid = await subDoc(m, await planOrder(m));
  const did = (await col.deliveries(db).insertOne({ subscriptionId: sid, mobile: m, date: TODAY, kind: 'cow', litres: 1, pincode: '500001', status: 'locked', source: 'plan' })).insertedId;
  await markNotDelivered(did, { reason: 'refused', note: 'x'.repeat(800) }, staff);
  const d = await col.deliveries(db).findOne({ _id: did });
  t('SEC-8 reasonNote cut to 500', d?.reasonNote?.length === 500, d?.reasonNote?.length);
});

// ---- P1-6 · two concurrent extras for one day: one is refused before paying ----
await caseRun('P1-6 concurrent extras', async () => {
  const m = freshMobile();
  const { order } = await createCheckoutOrder(input(m), at(m));
  await markOrderPaid(order._id, { razorpayPaymentId: 'pay_x', source: 'verify' }, at(m));
  const sub = (await col.subscriptions(db).findOne({ orderId: order._id }))!;
  await addCredit({ mobile: m, amountPaise: 50_000, kind: 'goodwill', refundable: false }, sys);
  const date = addDaysYMD(sub.startDate, 2);
  const mk = () => createExtraOrder({ mobile: m, subscriptionId: sub._id!, date, kind: 'cow', litres: 1, useCredit: true, idempotencyKey: `fx1x${new ObjectId().toHexString()}` }, at(m));
  const res = await Promise.allSettled([mk(), mk()]);
  const refused = res.filter(r => r.status === 'rejected' && r.reason instanceof ConflictError).length;
  t('P1-6 exactly one of two is refused', refused === 1, res.map(r => r.status));
  const paid = await col.orders(db).countDocuments({ mobile: m, purpose: 'extra', status: 'paid' });
  t('P1-6 only one extra paid', paid === 1, paid);
  t('P1-6 credit spent once', (await creditBalance(m)).balancePaise === 50_000 - 11_500);

  // activation-time clash: a second paid extra for a day already held → credited
  const second = (
    await col.orders(db).insertOne({
      razorpayOrderId: `order_it_${new ObjectId().toHexString()}`, mobile: m, purpose: 'extra', kind: 'cow', quantityId: 'extra', tenureId: 'extra',
      amountPaise: 11_500, perLitrePaise: 11_500, days: 1, litres: 1, pincode: sub.pincode, creditAppliedPaise: 0, payablePaise: 11_500,
      extra: { date, kind: 'cow', litres: 1, subscriptionId: sub._id! }, status: 'paid', createdAt: NOW, paidAt: NOW,
    })
  ).insertedId;
  const before = await creditBalance(m);
  await activateExtraOrder(second, at(m));
  await activateExtraOrder(second, at(m));
  const after = await creditBalance(m);
  t('P1-6 the clashing paid extra is credited once, refundable', after.balancePaise - before.balancePaise === 11_500 && after.refundablePaise - before.refundablePaise === 11_500, [before, after]);
});

// ---- P2-10 · only the money share of an extra becomes refundable --------------
await caseRun('P2-10 extras credit split', async () => {
  const m = freshMobile();
  await user(m);
  const sid = await subDoc(m, await planOrder(m));
  const mkExtra = async (date: string) =>
    (
      await col.orders(db).insertOne({
        razorpayOrderId: `order_it_${new ObjectId().toHexString()}`, mobile: m, purpose: 'extra', kind: 'cow', quantityId: 'extra', tenureId: 'extra',
        amountPaise: 11_500, perLitrePaise: 11_500, days: 1, litres: 1, pincode: '500001', creditAppliedPaise: 5_000, payablePaise: 6_500,
        extra: { date, kind: 'cow', litres: 1, subscriptionId: sid }, status: 'paid', createdAt: NOW, paidAt: NOW,
      })
    ).insertedId;
  // late (today is locked): creditLateExtra
  const late = await mkExtra(TODAY);
  await activateExtraOrder(late, at(m));
  await activateExtraOrder(late, at(m));
  let b = await creditBalance(m);
  t('P2-10 late extra: full price back, only ₹65 refundable', b.balancePaise === 11_500 && b.refundablePaise === 6_500, b);

  // missed extra (our fault): compensation
  const eo = await mkExtra('2031-05-08');
  const did = await missed(m, sid, '2031-05-08', { source: 'extra', orderId: eo });
  await compensateMissedDelivery(did, sys);
  b = await creditBalance(m);
  t('P2-10 missed extra: +₹115, +₹65 refundable', b.balancePaise === 23_000 && b.refundablePaise === 13_000, b);
  const rev = await reverseCompensation(did, staff);
  b = await creditBalance(m);
  t('P2-10 reversal takes both shares back, refundable intact', rev.reversed && b.balancePaise === 11_500 && b.refundablePaise === 6_500, b);
});

// ---- P2-6 · a missed day of a cancelled plan is made good at the standard rate --
await caseRun('P2-6 cancelled-plan miss', async () => {
  const m = freshMobile();
  await user(m);
  const sid = await subDoc(m, await planOrder(m), { status: 'cancelled', cancelEffectiveDate: TODAY });
  const did = await missed(m, sid, addDaysYMD(TODAY, -2));
  const r = await compensateMissedDelivery(did, sys);
  const b = await creditBalance(m);
  t('P2-6 credit at ₹115 (standard daily), not ₹97.75', r.resolution === 'credit' && b.balancePaise === 11_500, [r, b]);
});

// ---- P2-7 · reversal then re-compensation; a kept compensation stays -----------
await caseRun('P2-7 recompensate', async () => {
  const m = freshMobile();
  await user(m, { missedDeliveryPreference: 'credit' });
  const sid = await subDoc(m, await planOrder(m));
  const did = await missed(m, sid, addDaysYMD(TODAY, -1));
  await compensateMissedDelivery(did, sys);
  await reverseCompensation(did, staff);
  t('P2-7 reversed → balance 0', (await creditBalance(m)).balancePaise === 0);
  await compensateMissedDelivery(did, sys);
  const d = await col.deliveries(db).findOne({ _id: did });
  t('P2-7 re-compensation adds fresh credit', (await creditBalance(m)).balancePaise === 9_775 && d?.resolution === 'credit', await creditBalance(m));

  // kept: credit spent, reversal cannot take it back → resolution stays, no double
  await spendCredit(m, 9_775, 'adjustment', { note: 'spent elsewhere' }, sys);
  const k = await reverseCompensation(did, staff);
  const dk = await col.deliveries(db).findOne({ _id: did });
  t('P2-7 kept leaves the resolution', !k.reversed && dk?.resolution === 'credit', dk?.resolution);
  const again = await compensateMissedDelivery(did, sys);
  t('P2-7 kept + re-flip does not pay twice', again.alreadyResolved && (await creditBalance(m)).balancePaise === 0);

  // make-up kept: the make-up day already went out
  const m2 = freshMobile();
  await user(m2);
  const sid2 = await subDoc(m2, await planOrder(m2));
  const did2 = await missed(m2, sid2, addDaysYMD(TODAY, -1));
  await compensateMissedDelivery(did2, sys);
  const d2 = await col.deliveries(db).findOne({ _id: did2 });
  await col.deliveries(db).updateOne({ _id: d2!.compensationDeliveryId! }, { $set: { status: 'delivered' } });
  await reverseCompensation(did2, staff);
  await compensateMissedDelivery(did2, sys);
  const mk = await col.deliveries(db).countDocuments({ subscriptionId: sid2, source: 'makeup' });
  t('P2-7 kept make-up is not followed by a second make-up', mk === 1, mk);
});

// ---- P2-5 · crash between extend and resolution write: no second make-up --------
await caseRun('P2-5 makeup crash window', async () => {
  const m = freshMobile();
  await user(m);
  const sid = await subDoc(m, await planOrder(m));
  const did = await missed(m, sid, addDaysYMD(TODAY, -1));
  const s0 = (await col.subscriptions(db).findOne({ _id: sid }))!;
  // the crashed attempt: marker written, day appended, resolution never written
  await col.deliveries(db).updateOne({ _id: did }, { $set: { makeupPendingFrom: s0.endDate } });
  await extendSubscription(sid, 1, 'makeup', sys);
  const r = await compensateMissedDelivery(did, sys);
  const s1 = (await col.subscriptions(db).findOne({ _id: sid }))!;
  const mk = await col.deliveries(db).countDocuments({ subscriptionId: sid, source: 'makeup' });
  const d = await col.deliveries(db).findOne({ _id: did });
  t('P2-5 adopted the appended day', r.resolution === 'makeup_day' && mk === 1 && s1.endDate === addDaysYMD(s0.endDate, 1), [mk, s1.endDate]);
  t('P2-5 marker cleared, make-up linked', d?.compensationDeliveryId !== undefined && (d as { makeupPendingFrom?: string }).makeupPendingFrom === undefined);
});

// ---- P2-8 · two staff set the fault at once: one wins, state consistent --------
await caseRun('P2-8 setFault CAS', async () => {
  for (let i = 0; i < 3; i++) {
    const m = freshMobile();
    await user(m, { missedDeliveryPreference: 'credit' });
    const sid = await subDoc(m, await planOrder(m));
    const did = await missed(m, sid, addDaysYMD(TODAY, -1), { fault: 'unknown', reason: 'other' });
    const res = await Promise.allSettled([setFault(did, 'ours', staff), setFault(did, 'customer', staff)]);
    const d = await col.deliveries(db).findOne({ _id: did });
    const bal = (await creditBalance(m)).balancePaise;
    const consistent = d?.fault === 'ours' ? bal === 9_775 && d.resolution === 'credit' : bal === 0 && !d?.resolution;
    t(`P2-8 run ${i}: exactly one write wins, fault and credit agree`, res.filter(r => r.status === 'rejected').length === 1 && consistent, [res.map(r => r.status), d?.fault, bal]);
  }
});

// ---- P2-9 · a delivered correction waits for an in-flight compensation ---------
await caseRun('P2-9 markDelivered vs compensation', async () => {
  const m = freshMobile();
  await user(m, { missedDeliveryPreference: 'credit' });
  const sid = await subDoc(m, await planOrder(m));
  const did = await missed(m, sid, addDaysYMD(TODAY, -1));
  await col.deliveries(db).updateOne({ _id: did }, { $set: { compensatingUntil: new Date(Date.now() + 60_000) } });
  const e = await threw(markDelivered(did, { capturedAt: NOW }, staff, { note: 'customer confirmed' }));
  t('P2-9 refused while a compensation holds the row', e instanceof ConflictError);
  await col.deliveries(db).updateOne({ _id: did }, { $unset: { compensatingUntil: '' } });
  await compensateMissedDelivery(did, sys);
  await markDelivered(did, { capturedAt: NOW }, staff, { note: 'customer confirmed' });
  const d = await col.deliveries(db).findOne({ _id: did });
  t('P2-9 after it finished: delivered, compensation reversed', d?.status === 'delivered' && !d.resolution && (await creditBalance(m)).balancePaise === 0);
});

// ---- P2-11 · refund adopts a crashed attempt's payout; debit under the lease ----
await caseRun('P2-11 refund credit leg', async () => {
  const m = freshMobile();
  await user(m);
  const oid = await planOrder(m, { paidAt: new Date(NOW.getTime() - 200 * 86_400_000) });
  const sid = await subDoc(m, oid, { status: 'cancelled', cancelEffectiveDate: TODAY });
  await charged(m, sid);
  await addCredit({ mobile: m, amountPaise: 9_775, kind: 'missed_delivery', refundable: true, subscriptionId: sid }, sys);
  const orphanId = new ObjectId();
  await spendCredit(m, 9_775, 'refund_payout', { refundId: orphanId, subscriptionId: sid }, sys); // crash: no refund row
  const r = await createCancellationRefund(sid, sys);
  const payouts = await col.credits(db).find({ subscriptionId: sid, kind: 'refund_payout' }).toArray();
  t('P2-11 refund adopts the orphan payout id', r?._id?.equals(orphanId) === true);
  t('P2-11 refund still includes the missed-day credit', r?.amountPaise === 2_829_000 + 9_775, r?.amountPaise);
  t('P2-11 payout debited once', payouts.reduce((s, p) => s + p.amountPaise, 0) === -9_775 && (await creditBalance(m)).balancePaise === 0);

  // concurrent spend vs refund: never both, balance never negative, refund never throws
  const m2 = freshMobile();
  await user(m2);
  const oid2 = await planOrder(m2, { paidAt: new Date(NOW.getTime() - 200 * 86_400_000) });
  const sid2 = await subDoc(m2, oid2, { status: 'cancelled', cancelEffectiveDate: TODAY });
  await charged(m2, sid2);
  await addCredit({ mobile: m2, amountPaise: 9_775, kind: 'missed_delivery', refundable: true, subscriptionId: sid2 }, sys);
  const [rr, sp] = await Promise.allSettled([createCancellationRefund(sid2, sys), spendCredit(m2, 9_775, 'extra_spend', { note: 'race' }, sys)]);
  const bal = (await creditBalance(m2)).balancePaise;
  const ref = await col.refunds(db).findOne({ subscriptionId: sid2 });
  const outFromCredit = (ref?.amountPaise ?? 0) - 2_829_000;
  t('P2-11 refund did not throw', rr.status === 'fulfilled', rr.status === 'rejected' ? String(rr.reason) : '');
  t('P2-11 credit used once: refunded XOR spent', bal === 0 && (sp.status === 'fulfilled' ? outFromCredit === 0 : outFromCredit === 9_775), [sp.status, outFromCredit, bal]);
});

// ---- P2-2 · late payment on an expired order whose credit was not yet returned --
await caseRun('P2-2 expiry vs late payment', async () => {
  const m = freshMobile();
  await user(m);
  await addCredit({ mobile: m, amountPaise: 100_000, kind: 'goodwill', refundable: false }, sys);
  const { order } = await createCheckoutOrder(input(m, { useCredit: true }), at(m));
  const applied = order.creditAppliedPaise ?? 0;
  await addCredit({ mobile: m, amountPaise: 500_000, kind: 'goodwill', refundable: false }, sys); // later credit, so a double re-debit would succeed
  // expiry wrote 'expired' then crashed before returning the credit
  await col.orders(db).updateOne({ _id: order._id }, { $set: { status: 'expired', expiredAt: NOW } });
  await markOrderPaid(order._id, { razorpayPaymentId: 'pay_late', source: 'webhook' }, at(m));
  await expireUnpaidOrders(at(m, new Date(NOW.getTime() + 60 * 60_000)));
  t('P2-2 credit spent exactly once', applied > 0 && (await creditBalance(m)).balancePaise === 600_000 - applied, [(await creditBalance(m)).balancePaise, applied]);

  // crashed expiry, never paid: the sweep returns the credit
  const m2 = freshMobile();
  await user(m2);
  await addCredit({ mobile: m2, amountPaise: 100_000, kind: 'goodwill', refundable: false }, sys);
  const o2 = (await createCheckoutOrder(input(m2, { useCredit: true }), at(m2))).order;
  await col.orders(db).updateOne({ _id: o2._id }, { $set: { status: 'expired', expiredAt: NOW } });
  const rep = await expireUnpaidOrders(at(m2, new Date(NOW.getTime() + 60 * 60_000)));
  await expireUnpaidOrders(at(m2, new Date(NOW.getTime() + 61 * 60_000)));
  t('P2-2 sweep returned the stranded credit once', (await creditBalance(m2)).balancePaise === 100_000 && rep.creditReturned >= 1, [(await creditBalance(m2)).balancePaise, rep]);

  // normal race order: expiry returned it, late payment re-debits it
  const m3 = freshMobile();
  await user(m3);
  await addCredit({ mobile: m3, amountPaise: 100_000, kind: 'goodwill', refundable: false }, sys);
  const o3 = (await createCheckoutOrder(input(m3, { useCredit: true }), at(m3))).order;
  await expireUnpaidOrders(at(m3, new Date(NOW.getTime() + 60 * 60_000)));
  t('P2-2 expiry returned credit', (await creditBalance(m3)).balancePaise === 100_000);
  await markOrderPaid(o3._id, { razorpayPaymentId: 'pay_late3', source: 'webhook' }, at(m3));
  t('P2-2 late payment re-debited once', (await creditBalance(m3)).balancePaise === 100_000 - (o3.creditAppliedPaise ?? 0));
});

// ---- P2-3 · a spend whose order was never inserted is returned -----------------
await caseRun('P2-3 orphan checkout spend', async () => {
  const m = freshMobile();
  await user(m);
  await addCredit({ mobile: m, amountPaise: 50_000, kind: 'goodwill', refundable: false }, sys);
  const ghost = new ObjectId();
  const spentAt = new Date(NOW.getTime() - 3 * 3_600_000);
  await spendCredit(m, 20_000, 'order_spend', { orderId: ghost, note: 'checkout new' }, { ...sys, now: spentAt });
  // a fresh one (checkout still in flight) must be left alone
  const inflight = new ObjectId();
  await spendCredit(m, 5_000, 'order_spend', { orderId: inflight, note: 'checkout new' }, sys);
  await expireUnpaidOrders(sys);
  await expireUnpaidOrders(sys);
  t('P2-3 abandoned spend returned once, in-flight kept', (await creditBalance(m)).balancePaise === 45_000, (await creditBalance(m)).balancePaise);
});

// ---- P1-7 · a paid order whose activation failed is repaired -------------------
await caseRun('P1-7 repair', async () => {
  // credit-only checkout, subscription lost
  const m = freshMobile();
  await user(m);
  await addCredit({ mobile: m, amountPaise: 1_000_000, kind: 'goodwill', refundable: false }, sys);
  const inp = input(m, { useCredit: true });
  const { order } = await createCheckoutOrder(inp, at(m));
  t('P1-7 credit-only order paid', order.status === 'paid', order.status);
  const drop = async () => {
    const s = await col.subscriptions(db).findOne({ orderId: order._id });
    await col.deliveries(db).deleteMany({ subscriptionId: s!._id! });
    await col.subscriptions(db).deleteOne({ _id: s!._id! });
  };
  await drop();
  await createCheckoutOrder(inp, at(m));
  t('P1-7 checkout replay re-activates', (await col.subscriptions(db).countDocuments({ orderId: order._id })) === 1);

  await drop();
  const tooSoon = await repairPaidOrders(at(m, new Date(NOW.getTime() + 60_000)));
  t('P1-7 not repaired within 2 minutes of payment', (await col.subscriptions(db).countDocuments({ orderId: order._id })) === 0, tooSoon);
  const r = await repairPaidOrders(at(m, new Date(NOW.getTime() + 5 * 60_000)));
  t('P1-7 tick repairs the subscription', r.repaired >= 1 && (await col.subscriptions(db).countDocuments({ orderId: order._id })) === 1, r);
  const again = await repairPaidOrders(at(m, new Date(NOW.getTime() + 10 * 60_000)));
  t('P1-7 idempotent', (await col.subscriptions(db).countDocuments({ orderId: order._id })) === 1 && again.failed === 0, again);

  // paid extra with neither delivery nor credit
  const sub = (await col.subscriptions(db).findOne({ orderId: order._id }))!;
  const date = addDaysYMD(sub.startDate, 3);
  const ex = await createExtraOrder({ mobile: m, subscriptionId: sub._id!, date, kind: 'cow', litres: 1, useCredit: true, idempotencyKey: `fx1r${new ObjectId().toHexString()}` }, at(m));
  await col.deliveries(db).deleteMany({ orderId: ex.order._id });
  const r2 = await repairPaidOrders(at(m, new Date(NOW.getTime() + 5 * 60_000)));
  t('P1-7 tick repairs a paid extra', r2.repaired >= 1 && (await col.deliveries(db).countDocuments({ orderId: ex.order._id })) === 1, r2);
});

console.log(`fx1: ${passed} passed, ${failed} failed · db=${db.databaseName}`);
process.exit(failed ? 1 : 0);
