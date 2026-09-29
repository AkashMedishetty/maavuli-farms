/**
 * B3 money — integration test against a real, isolated Mongo.
 *   MONGODB_DB=maavuli_it_b3 pnpm db:init          # once
 *   MONGODB_DB=maavuli_it_b3 pnpm it scripts/it/b3-money.ts
 *
 * Never calls live Razorpay: fetch to api.razorpay.com is stubbed to throw unless
 * RAZORPAY_IT=1. Other owners' functions that still throw 'not implemented' are
 * reported NOT VERIFIED instead of failing.
 */

import { createHmac } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, type Order, type Subscription } from '@/lib/models';
import { systemCtx, customerActor, type OpCtx } from '@/lib/clock';
import { addDaysYMD, istYMD } from '@/lib/cutoff';
import { dateRange } from '@/lib/subscriptions';
import { addCredit, creditBalance, spendCredit } from '@/lib/credits';
import { compensateMissedDelivery, reverseCompensation, compensatePendingMisses } from '@/lib/compensation';
import { createExtraOrder, activateExtraOrder, extraPricePaise } from '@/lib/extras';
import { createCancellationRefund, setRefundUpi, recordManualRefund } from '@/lib/refunds';

if (!process.env.MONGODB_DB?.startsWith('maavuli_it_b3')) {
  console.error('refusing to run: set MONGODB_DB=maavuli_it_b3');
  process.exit(2);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('api.razorpay.com') && process.env.RAZORPAY_IT !== '1') throw new Error('IT: live Razorpay call blocked');
  return realFetch(input, init);
}) as typeof fetch;

let passed = 0;
let failed = 0;
const notVerified: string[] = [];
function t(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}`, detail ?? '');
  }
}
const isStub = (e: unknown) => e instanceof Error && /not implemented/.test(e.message);

const db = await getDb();
const now = new Date('2026-06-10T04:00:00.000Z'); // 09:30 IST → first open date is 2026-06-11
const today = istYMD(now);
const ctx: OpCtx = systemCtx(now, 'it_b3');
const PREFIX = /^930000/;

async function clean() {
  for (const c of [col.users(db), col.orders(db), col.subscriptions(db), col.deliveries(db), col.credits(db), col.refunds(db), col.outbox(db)]) {
    await (c as unknown as { deleteMany: (f: object) => Promise<unknown> }).deleteMany({ mobile: PREFIX });
  }
  await col.webhookEvents(db).deleteMany({ eventId: /^it_b3_/ });
  await col.dayLocks(db).deleteMany({ _id: { $gte: '2026-06-01', $lte: '2026-06-30' } });
}
await clean();

async function user(mobile: string, extra: Record<string, unknown> = {}) {
  await col.users(db).insertOne({ mobile, createdAt: now, ...extra });
}
async function planOrder(mobile: string, extra: Partial<Order> = {}): Promise<ObjectId> {
  return (
    await col.orders(db).insertOne({
      razorpayOrderId: `order_it_${new ObjectId().toHexString()}`,
      mobile, purpose: 'new', kind: 'cow', quantityId: 'one', tenureId: '1y',
      amountPaise: 3_519_000, perLitrePaise: 9_775, days: 360, litres: 360, pincode: '500001',
      status: 'paid', createdAt: now, paidAt: now, ...extra,
    })
  ).insertedId;
}
async function sub(mobile: string, orderId: ObjectId, extra: Partial<Subscription> = {}): Promise<ObjectId> {
  return (
    await col.subscriptions(db).insertOne({
      orderId, mobile, kind: 'cow', qtyNum: 1, qtyDen: 1, startDate: '2026-06-01', endDate: '2026-06-20',
      daysTotal: 20, daysDelivered: 0, daysPaused: 0, status: 'active', pauseAllowanceDays: 3, pauseUsedDays: 0,
      pincode: '500001', createdAt: now, ...extra,
    })
  ).insertedId;
}

/* ---------------------------------------------------------- 1. concurrent spends */
{
  const m = '9300000001';
  await user(m);
  await addCredit({ mobile: m, amountPaise: 10_000, kind: 'goodwill', refundable: false }, ctx);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => spendCredit(m, 3_000, 'adjustment', { note: 'it race' }, ctx)),
  );
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const bal = await creditBalance(m);
  t('10 concurrent ₹30 spends on ₹100: exactly 3 succeed', ok === 3, { ok });
  t('balance never negative after the race (₹10 left)', bal.balancePaise === 1_000, bal);
}

/* -------------------------------------------------- 2. compensation: make-up day */
{
  const m = '9300000002';
  await user(m);
  const oid = await planOrder(m);
  const sid = await sub(m, oid);
  const did = (
    await col.deliveries(db).insertOne({
      subscriptionId: sid, mobile: m, date: '2026-06-09', kind: 'cow', litres: 1, pincode: '500001',
      status: 'not_delivered', source: 'plan', reason: 'out_of_stock', fault: 'ours',
    })
  ).insertedId;
  const [a, b] = await Promise.all([compensateMissedDelivery(did, ctx), compensateMissedDelivery(did, ctx)]);
  const s1 = await col.subscriptions(db).findOne({ _id: sid });
  const makeups = await col.deliveries(db).countDocuments({ subscriptionId: sid, source: 'makeup' });
  t('make-up: resolution makeup_day', [a.resolution, b.resolution].includes('makeup_day'), { a, b });
  t('make-up: two concurrent calls append exactly one day', makeups === 1 && s1?.endDate === '2026-06-21', { makeups, end: s1?.endDate });
  const again = await compensateMissedDelivery(did, ctx);
  t('make-up: a repeat call is alreadyResolved', again.alreadyResolved);
  const msg = await col.outbox(db).countDocuments({ dedupeKey: `missed:${did.toHexString()}` });
  t('make-up: not_delivered_ours enqueued once', msg === 1, { msg });

  const rev = await reverseCompensation(did, ctx);
  const s2 = await col.subscriptions(db).findOne({ _id: sid });
  const d2 = await col.deliveries(db).findOne({ _id: did });
  t('reverse make-up: day removed, endDate back to 06-20', rev.reversed && s2?.endDate === '2026-06-20' && (await col.deliveries(db).countDocuments({ subscriptionId: sid, source: 'makeup' })) === 0, { rev, end: s2?.endDate });
  t('reverse make-up: resolution cleared; repeat reverse is a no-op', !d2?.resolution && !(await reverseCompensation(did, ctx)).reversed);
}

/* ------------------------------------------------------- 3. compensation: credit */
{
  const m = '9300000003';
  await user(m, { missedDeliveryPreference: 'credit' });
  const oid = await planOrder(m);
  const sid = await sub(m, oid);
  const did = (
    await col.deliveries(db).insertOne({
      subscriptionId: sid, mobile: m, date: '2026-06-09', kind: 'cow', litres: 1, pincode: '500001',
      status: 'not_delivered', source: 'plan', reason: 'disruption', fault: 'ours',
    })
  ).insertedId;
  const pending = await compensatePendingMisses(ctx);
  const d = await col.deliveries(db).findOne({ _id: did });
  const bal = await creditBalance(m);
  t('sweep compensated the pending miss', pending.compensated >= 1 && d?.resolution === 'credit', pending);
  t('credit = perLitrePaise × litres at the price paid (₹97.75), refundable', bal.balancePaise === 9_775 && bal.refundablePaise === 9_775, bal);
  t('disruption: no not_delivered_ours message', (await col.outbox(db).countDocuments({ dedupeKey: `missed:${did.toHexString()}` })) === 0);
  const rev = await reverseCompensation(did, ctx);
  const bal2 = await creditBalance(m);
  t('reverse credit: offsetting adjustment, balance 0', rev.reversed && bal2.balancePaise === 0 && bal2.refundablePaise === 0, bal2);
}

/* ----------------------------------------------------------- 4. credit-only extra */
{
  const m = '9300000004';
  await user(m);
  const oid = await planOrder(m);
  const sid = await sub(m, oid);
  const price = extraPricePaise('cow', 1.5);
  await addCredit({ mobile: m, amountPaise: price + 500, kind: 'goodwill', refundable: false }, ctx);
  const date = addDaysYMD(today, 2);
  try {
    const r = await createExtraOrder({ mobile: m, subscriptionId: sid, date, kind: 'cow', litres: 1.5, useCredit: true, idempotencyKey: 'it_b3_extra_0001' }, ctx);
    t('credit-only extra: synthetic credit_ id, no Razorpay', r.order.razorpayOrderId.startsWith('credit_') && r.razorpay === null);
    const again = await createExtraOrder({ mobile: m, subscriptionId: sid, date, kind: 'cow', litres: 1.5, useCredit: true, idempotencyKey: 'it_b3_extra_0001' }, ctx);
    t('credit-only extra: same key replays the same order', again.order._id.equals(r.order._id));
    t('credit-only extra: ₹5 left after spending ₹172.50', (await creditBalance(m)).balancePaise === 500);
    const row = await col.deliveries(db).findOne({ subscriptionId: sid, date, source: 'extra' });
    t('credit-only extra: planned extra delivery created on activation', row?.status === 'planned' && row.litres === 1.5);
  } catch (e) {
    if (isStub(e)) notVerified.push('credit-only extra activation (markOrderPaid/activateOrder not implemented by B1 yet)');
    else t('credit-only extra', false, e);
  }

  // payment landing after the cutoff → full price back as refundable credit
  const lateId = (
    await col.orders(db).insertOne({
      razorpayOrderId: `order_it_${new ObjectId().toHexString()}`, mobile: m, purpose: 'extra', kind: 'cow',
      quantityId: 'extra', tenureId: 'extra', amountPaise: extraPricePaise('cow', 1), perLitrePaise: 11_500, days: 1, litres: 1,
      pincode: '500001', extra: { date: today, kind: 'cow', litres: 1, subscriptionId: sid }, status: 'paid', createdAt: now, paidAt: now,
    })
  ).insertedId;
  const before = (await creditBalance(m)).refundablePaise;
  await activateExtraOrder(lateId, ctx);
  await activateExtraOrder(lateId, ctx);
  const after = await creditBalance(m);
  t('late extra: no delivery on a locked date', (await col.deliveries(db).countDocuments({ orderId: lateId })) === 0);
  t('late extra: full price credited once, refundable', after.refundablePaise - before === 11_500, { before, after });
}

/* ------------------------------ 5. old payment → awaiting_upi → paid manually */
{
  const m = '9300000005';
  await user(m);
  const paidAt = new Date(now.getTime() - 200 * 86_400_000);
  const oid = await planOrder(m, { paidAt, razorpayPaymentId: 'pay_IToldpayment1' });
  const sid = await sub(m, oid, { startDate: '2026-04-01', endDate: '2027-03-26', daysTotal: 360, status: 'cancelled', cancelledAt: now });
  await col.deliveries(db).insertMany(
    dateRange('2026-04-01', 60).map(date => ({ subscriptionId: sid, mobile: m, date, kind: 'cow' as const, litres: 1, pincode: '500001', status: 'delivered' as const, source: 'plan' as const })),
  );
  await addCredit({ mobile: m, amountPaise: 9_775, kind: 'missed_delivery', refundable: true, subscriptionId: sid }, ctx);
  const r = await createCancellationRefund(sid, ctx);
  t('old payment: refund = ₹28,290 + ₹97.75 missed-day credit', r?.amountPaise === 2_838_775, r?.amountPaise);
  t('old payment: parked awaiting_upi', r?.status === 'awaiting_upi', r?.status);
  t('old payment: refundable credit consumed by refund_payout', (await creditBalance(m)).balancePaise === 0);
  t('old payment: refund_needs_upi enqueued', (await col.outbox(db).countDocuments({ dedupeKey: `refund_upi:${String(r?._id)}` })) === 1);
  const dup = await createCancellationRefund(sid, ctx);
  t('cancellation refund is idempotent per subscription', String(dup?._id) === String(r?._id) && (await col.refunds(db).countDocuments({ subscriptionId: sid })) === 1 && (await creditBalance(m)).balancePaise === 0);
  if (r?._id) {
    let denied = false;
    try { await setRefundUpi(r._id, '9300000009', 'x@okaxis', { now, actor: customerActor('9300000009') }); } catch { denied = true; }
    t("another customer's refund is not found", denied);
    await setRefundUpi(r._id, m, 'ravi@okaxis', { now, actor: customerActor(m) });
    const done = await recordManualRefund(r._id, { upiId: 'ravi@okaxis', utr: 'UTR123456789' }, ctx);
    const o = await col.orders(db).findOne({ _id: oid });
    t('manual payout: paid_manually with UTR', done.status === 'paid_manually' && done.utr === 'UTR123456789');
    t('manual payout: order refundedPaise + partially_refunded', o?.refundedPaise === 2_838_775 && o.status === 'partially_refunded', o?.status);
  }
}

/* --------------------------------------------- 6. refund.processed via the webhook */
{
  const m = '9300000006';
  await user(m);
  const oid = await planOrder(m, { razorpayPaymentId: 'pay_ITwebhook0001', amountPaise: 345_000 });
  const sid = await sub(m, oid, { status: 'cancelled' });
  const refundId = (
    await col.refunds(db).insertOne({
      mobile: m, subscriptionId: sid, orderId: oid, amountPaise: 345_000, method: 'razorpay', status: 'processing',
      razorpayPaymentId: 'pay_ITwebhook0001', razorpayRefundId: 'rfnd_ITwebhook0001',
      breakdown: { planPaise: 345_000, chargedDays: 0, standardDailyPaise: 11_500, chargedPaise: 0, balancePaise: 345_000, refundableCreditPaise: 0, toSourcePaise: 345_000, toCreditPaise: 0 },
      createdAt: now, updatedAt: now,
    })
  ).insertedId;
  process.env.RAZORPAY_KEY_ID ||= 'rzp_test_it';
  process.env.RAZORPAY_KEY_SECRET ||= 'it_key_secret';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'it_b3_webhook_secret';
  const { POST } = await import('@/app/api/webhooks/razorpay/route');
  const body = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_ITwebhook0001', payment_id: 'pay_ITwebhook0001', amount: 345_000, status: 'processed' } } } });
  const sig = createHmac('sha256', 'it_b3_webhook_secret').update(body).digest('hex');
  const call = (s: string) =>
    POST(new Request('http://localhost/api/webhooks/razorpay', { method: 'POST', body, headers: { 'x-razorpay-signature': s, 'x-razorpay-event-id': 'it_b3_evt_1' } }));
  const bad = await call('00'.repeat(32));
  t('webhook: bad signature → 400', bad.status === 400);
  const res = await call(sig);
  const rf = await col.refunds(db).findOne({ _id: refundId });
  const o = await col.orders(db).findOne({ _id: oid });
  t('webhook: refund.processed → 200, refund processed', res.status === 200 && rf?.status === 'processed', { status: res.status, rf: rf?.status });
  t('webhook: order fully refunded', o?.status === 'refunded' && o.refundedPaise === 345_000, o?.status);
  const replay = await call(sig);
  const replayBody = (await replay.json()) as { status?: string };
  t('webhook: replayed event id is a no-op duplicate', replay.status === 200 && replayBody.status === 'duplicate' && (await col.orders(db).findOne({ _id: oid }))?.refundedPaise === 345_000);
}

await clean();
console.log(`\n${passed} passed, ${failed} failed`);
if (notVerified.length) console.log(`NOT VERIFIED:\n - ${notVerified.join('\n - ')}`);
process.exit(failed ? 1 : 0);
