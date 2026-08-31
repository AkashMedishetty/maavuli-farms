/**
 * End-to-end walk of the real customer flow, over HTTP only.
 *
 *   node --env-file-if-exists=.env.local scripts/e2e-flow.mjs [mobile]
 *
 * Nothing here is faked except the one thing that cannot be automated: the card
 * entry inside Razorpay's own iframe. Everything either side of it is real —
 * a real OTP session, a real Razorpay TEST order created through their API, and a
 * real HMAC handshake computed exactly as Razorpay Checkout computes it.
 *
 * Session cookies cannot be forged from the database: the session token is hashed
 * at rest, so the only way in is the actual OTP flow. That is by design, and this
 * script goes through the front door.
 *
 * It also asserts the negative cases, because a payment endpoint that accepts a
 * bad signature is worse than one that is merely broken.
 */
import { createHmac } from 'node:crypto';
import { MongoClient } from 'mongodb';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3000';
const MOBILE = (process.argv[2] ?? '9000000001').replace(/\D/g, '').slice(-10);

let failures = 0;
const step = (n, label) => console.log(`\n${n}. ${label}`);
function check(label, cond, detail = '') {
  console.log(`   ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

const jsonPost = (path, body, cookie) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

async function main() {
  step(1, `OTP requested for ${MOBILE}`);
  const r1 = await jsonPost('/api/auth/request', { mobile: MOBILE });
  const b1 = await r1.json().catch(() => ({}));
  check('auth/request accepted', r1.status === 200, `status ${r1.status}`);
  const code = b1.devCode;
  check('dev code returned (no SMS provider configured)', typeof code === 'string', code ? `code ${code}` : JSON.stringify(b1).slice(0, 120));
  if (!code) return;

  step(2, 'OTP verified, session issued');
  const r2 = await jsonPost('/api/auth/verify', { mobile: MOBILE, code });
  check('auth/verify accepted', r2.status === 200, `status ${r2.status}`);
  const setCookie = r2.headers.get('set-cookie') ?? '';
  const m = /mv_session=([^;]+)/.exec(setCookie);
  check('mv_session cookie set', Boolean(m));
  if (!m) return;
  const cookie = `mv_session=${m[1]}`;
  check('cookie is httpOnly', /httponly/i.test(setCookie));
  check('cookie is sameSite', /samesite/i.test(setCookie));

  step(3, 'wrong OTP is rejected');
  const rBad = await jsonPost('/api/auth/verify', { mobile: MOBILE, code: '000000' });
  check('a wrong code does not issue a session', rBad.status === 401, `status ${rBad.status}`);

  step(4, 'session readable');
  const rMe = await fetch(BASE + '/api/auth/me', { headers: { cookie } });
  const me = await rMe.json().catch(() => ({}));
  check('auth/me returns the session', rMe.status === 200 && JSON.stringify(me).includes(MOBILE), JSON.stringify(me).slice(0, 120));

  step(5, 'order created — price is recomputed server-side');
  const rC = await jsonPost(
    '/api/checkout',
    {
      mobile: MOBILE,
      kind: 'cow',
      quantityId: 'one',
      tenureId: '1m',
      pincode: '500047',
      name: 'E2E Test Customer',
      address: 'Flat 4B, Sai Residency, Balram Nagar, Safilguda',
      landmark: 'opposite the water tank',
      lat: 17.4735,
      lng: 78.5468,
    },
    cookie,
  );
  const order = await rC.json().catch(() => ({}));
  check('checkout accepted', rC.status === 200, `status ${rC.status} ${JSON.stringify(order).slice(0, 160)}`);
  const rzpOrderId = order.razorpayOrderId ?? order.orderId ?? order.id;
  check('a razorpay order id came back', typeof rzpOrderId === 'string' && rzpOrderId.startsWith('order_'), String(rzpOrderId));
  if (!rzpOrderId || !String(rzpOrderId).startsWith('order_')) return;
  // cow, 1 litre/day, 30 days, no discount = 11500 paise x 30 = 345000
  check('amount matches the pricing engine (cow 1L 1m = 345000 paise)', order.amountPaise === 345000 || order.amount === 345000, `got ${order.amountPaise ?? order.amount}`);

  step(6, 'a delivery without a name or address is refused');
  for (const [label, patch] of [
    ['no name', { name: '' }],
    ['no address', { address: '' }],
    ['too-short address', { address: 'x' }],
  ]) {
    const r = await jsonPost('/api/checkout', {
      mobile: MOBILE, kind: 'cow', quantityId: 'one', tenureId: '1m', pincode: '500047',
      name: 'Someone', address: 'Flat 4B, Sai Residency, Balram Nagar, Safilguda', ...patch,
    }, cookie);
    check(`${label} -> 400`, r.status === 400, `status ${r.status}`);
  }

  step(7, 'payment confirmation rejects what it should');
  const fakeSig = 'a'.repeat(64);
  const paymentId = 'pay_e2e' + Math.random().toString(36).slice(2, 10);
  const rNoAuth = await jsonPost('/api/payments/verify', { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: fakeSig });
  check('no session -> 401', rNoAuth.status === 401, `status ${rNoAuth.status}`);
  const rBadSig = await jsonPost('/api/payments/verify', { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: fakeSig }, cookie);
  check('bad signature -> 400', rBadSig.status === 400, `status ${rBadSig.status}`);
  const rMissing = await jsonPost('/api/payments/verify', { razorpay_order_id: rzpOrderId }, cookie);
  check('missing fields -> 400', rMissing.status === 400, `status ${rMissing.status}`);

  step(8, 'valid handshake activates the subscription');
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) { check('RAZORPAY_KEY_SECRET present', false); return; }
  const sig = createHmac('sha256', secret).update(`${rzpOrderId}|${paymentId}`).digest('hex');
  const rOk = await jsonPost('/api/payments/verify', { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig }, cookie);
  const okBody = await rOk.json().catch(() => ({}));
  check('verify accepted', rOk.status === 200, `status ${rOk.status} ${JSON.stringify(okBody).slice(0, 200)}`);
  check('a subscription id came back', Boolean(okBody.subscriptionId), String(okBody.subscriptionId));

  step(9, 'replay is idempotent (the webhook may also arrive)');
  const rAgain = await jsonPost('/api/payments/verify', { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig }, cookie);
  const againBody = await rAgain.json().catch(() => ({}));
  check('second call does not create a second subscription', rAgain.status === 200 && againBody.status === 'already_paid', JSON.stringify(againBody).slice(0, 140));

  step(10, 'database reflects it');
  if (!process.env.MONGODB_URI) { check('MONGODB_URI present for the DB assertions', false); return; }
  const c = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await c.connect();
  const db = c.db(process.env.MONGODB_DB);
  // Assert per ORDER, not per mobile: a customer may legitimately hold several
  // subscriptions, and re-running this script re-uses the same test mobile. The real
  // invariant is that one paid order activates exactly one subscription.
  const paidOrder = await db.collection('orders').findOne({ razorpayOrderId: rzpOrderId });
  const subs = await db.collection('subscriptions').find({ orderId: paidOrder?._id }).toArray();
  check('this order activated exactly one subscription', subs.length === 1, `found ${subs.length}`);
  const sub = subs[0];
  if (sub) {
    console.log(`      ${sub.kind}  ${sub.qtyNum}/${sub.qtyDen} L/day  ${sub.startDate} -> ${sub.endDate}  ${sub.daysTotal}d  status=${sub.status}`);
    check('term is 30 days', sub.daysTotal === 30, `got ${sub.daysTotal}`);
    check('quantity stored as an exact fraction', sub.qtyNum === 1 && sub.qtyDen === 1, `${sub.qtyNum}/${sub.qtyDen}`);
    check('order marked paid', paidOrder?.status === 'paid', `status ${paidOrder?.status}`);
    check('rider gets a name', sub.name === 'E2E Test Customer', String(sub.name));
    check('rider gets an address', (sub.address ?? '').includes('Sai Residency'), String(sub.address));
    check('rider gets a landmark', sub.landmark === 'opposite the water tank', String(sub.landmark));
    check('rider gets an exact location', sub.location?.lat === 17.4735 && sub.location?.lng === 78.5468, JSON.stringify(sub.location));
    const user = await db.collection('users').findOne({ mobile: MOBILE });
    check('customer profile saved for next time', user?.name === 'E2E Test Customer' && Boolean(user?.address), JSON.stringify({ n: user?.name, a: (user?.address ?? '').slice(0, 24) }));
  }
  await c.close();
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
    process.exit(failures ? 1 : 0);
  })
  .catch(e => {
    console.error('\ne2e aborted:', e.message);
    process.exit(1);
  });
