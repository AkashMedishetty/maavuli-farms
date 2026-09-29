// Integration test for lib/admin-customers (B7b).
//   MONGODB_DB=maavuli_it_b7b pnpm db:init
//   MONGODB_DB=maavuli_it_b7b pnpm run it scripts/it/b7b-crm.ts
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, type Order, type Subscription } from '@/lib/models';
import { staffActor, type OpCtx } from '@/lib/clock';
import {
  abandonedCheckouts,
  addStaff,
  customerDetail,
  listOutbox,
  listStaff,
  listSubscriptions,
  searchCustomers,
  subscriptionOfCustomer,
  updateStaff,
} from '@/lib/admin-customers';

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
async function throwsName(name: string, errName: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    t(name, false, 'did not throw');
  } catch (e) {
    t(name, e instanceof Error && e.name === errName, e instanceof Error ? `${e.name}: ${e.message}` : e);
  }
}

const db = await getDb();
for (const c of ['users', 'orders', 'subscriptions', 'deliveries', 'credits', 'refunds', 'staff', 'tickets', 'outbox', 'events', 'paused_dates', 'day_locks', 'settings']) {
  await db.collection(c).deleteMany({});
}

const now = new Date('2026-10-01T06:30:00Z'); // 12:00 IST, before the 16:00 cutoff
const ctx: OpCtx = { now, actor: staffActor('9700000001') };
const A = '9711111111';
const B = '9722222222';
const C = '9733333333';

await col.users(db).insertMany([
  { mobile: A, name: 'Ravi (A.*) Kumar', address: 'Flat 4, Lake View', createdAt: now, whatsappOptIn: true },
  { mobile: B, name: 'Sita', address: 'Banjara Hills', createdAt: now },
  { mobile: C, name: 'Gopal', address: 'Kondapur', createdAt: now },
]);
await col.credits(db).insertOne({ mobile: A, amountPaise: 11_500, kind: 'goodwill', refundable: false, actor: ctx.actor, at: now });

const baseOrder = (mobile: string, status: Order['status'], createdAt: Date): Order => ({
  razorpayOrderId: `order_${new ObjectId().toHexString()}`,
  mobile,
  kind: 'cow',
  quantityId: 'one',
  tenureId: '1m',
  amountPaise: 345_000,
  perLitrePaise: 11_500,
  days: 30,
  litres: 1,
  pincode: '500032',
  status,
  createdAt,
});
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
const paidA = await col.orders(db).insertOne(baseOrder(A, 'paid', ago(5)));
await col.orders(db).insertOne(baseOrder(A, 'expired', ago(6))); // paid later -> not abandoned
await col.orders(db).insertOne(baseOrder(B, 'expired', ago(3)));
await col.orders(db).insertOne(baseOrder(B, 'created', ago(1))); // latest attempt
await col.orders(db).insertOne(baseOrder(C, 'expired', ago(40))); // outside the window

const sub: Subscription = {
  orderId: paidA.insertedId,
  mobile: A,
  kind: 'cow',
  qtyNum: 1,
  qtyDen: 1,
  startDate: '2026-09-20',
  endDate: '2026-10-05',
  daysTotal: 30,
  daysDelivered: 10,
  daysPaused: 0,
  status: 'active',
  pauseAllowanceDays: 3,
  pauseUsedDays: 0,
  pincode: '500032',
  address: 'Flat 4, Lake View',
  createdAt: ago(12),
};
const subId = (await col.subscriptions(db).insertOne(sub)).insertedId;
for (const date of ['2026-10-02', '2026-10-03', '2026-10-04']) {
  await col.deliveries(db).insertOne({ subscriptionId: subId, mobile: A, date, kind: 'cow', litres: 1, pincode: '500032', status: 'planned', source: 'plan' });
}
await col.deliveries(db).insertOne({
  subscriptionId: subId,
  mobile: A,
  date: '2026-09-30',
  kind: 'cow',
  litres: 1,
  pincode: '500032',
  status: 'delivered',
  source: 'plan',
  proof: { photoKey: 'proof/2026-09-30/a b.jpg' },
});
await col.outbox(db).insertOne({
  mobile: A,
  template: 'refund_processed',
  lang: 'en',
  params: { amount: '₹100' },
  dedupeKey: 'it:1',
  status: 'logged',
  attempts: 1,
  createdAt: now,
  updatedAt: now,
});

/* search */
t('search by mobile prefix', (await searchCustomers('97111')).map(r => r.mobile).join() === A);
t('search +91 form', (await searchCustomers('+91 97222 22222')).map(r => r.mobile).join() === B);
t('regex is escaped', (await searchCustomers('(A.*)')).map(r => r.mobile).join() === A);
t('escaped regex does not match everything', (await searchCustomers('Rav.*mar')).length === 0);
t('case-insensitive address', (await searchCustomers('banjara')).map(r => r.mobile).join() === B);
const sA = (await searchCustomers('Ravi'))[0];
t('row carries plan status + credit', sA?.planStatus === 'active' && sA.creditPaise === 11_500, sA);
t('empty query lists recent', (await searchCustomers('')).length === 3);

/* detail */
const d = await customerDetail(A, ctx);
t('detail exists', d !== null);
t('detail credit', d?.credit.balancePaise === 11_500);
t('detail pausable dates from first open', JSON.stringify(d?.plans[0]?.pausableDates) === JSON.stringify(['2026-10-02', '2026-10-03', '2026-10-04']), d?.plans[0]?.pausableDates);
t('detail photo url encoded', d?.deliveries.find(x => x.date === '2026-09-30')?.photoUrl === '/api/photos/proof/2026-09-30/a%20b.jpg');
t('detail message rendered', typeof d?.messages[0]?.text === 'string' && d.messages[0].text.includes('₹100'), d?.messages[0]);
t('detail unknown mobile = null', (await customerDetail('9799999999', ctx)) === null);

/* ownership */
t('subscriptionOfCustomer own', (await subscriptionOfCustomer(A, subId.toHexString()))._id.equals(subId));
await throwsName('subscriptionOfCustomer other mobile', 'NotFoundError', () => subscriptionOfCustomer(B, subId.toHexString()));
await throwsName('subscriptionOfCustomer bad id', 'NotFoundError', () => subscriptionOfCustomer(A, 'nope'));

/* abandoned */
const ab = await abandonedCheckouts(ctx);
t('abandoned only B', ab.map(r => r.mobile).join() === B, ab);
t('abandoned one row per mobile with attempts', ab[0]?.attempts === 2 && ab[0].status === 'created', ab[0]);

/* subscriptions */
t('ending within 7', (await listSubscriptions({ endingWithin: 7 }, ctx)).rows.length === 1);
t('renewal queued = none', (await listSubscriptions({ renewal: 'queued' }, ctx)).rows.length === 0);

/* outbox */
t('outbox filter template', (await listOutbox({ template: 'refund_processed' })).messages.length === 1);

/* staff */
process.env.ADMIN_MOBILES = '9700000001';
const owner2 = '9700000002';
const ops = '9700000003';
await addStaff({ mobile: owner2, name: 'Second owner', role: 'owner' }, ctx);
await addStaff({ mobile: ops, name: 'Ops person', role: 'ops' }, ctx);
await throwsName('dup staff', 'ConflictError', () => addStaff({ mobile: ops, name: 'Again', role: 'ops' }, ctx));
await throwsName('env owner cannot be added', 'ConflictError', () => addStaff({ mobile: '9700000001', name: 'Env', role: 'ops' }, ctx));
await throwsName('bad role', 'ValidationError', () => addStaff({ mobile: '9700000004', name: 'X Y', role: 'admin' }, ctx));
const ctx2: OpCtx = { now, actor: staffActor(owner2) };
await throwsName('self deactivate', 'ForbiddenError', () => updateStaff(owner2, { active: false }, owner2, ctx2));
await throwsName('self demote', 'ForbiddenError', () => updateStaff(owner2, { role: 'ops' }, owner2, ctx2));
await throwsName('env owner fixed', 'ForbiddenError', () => updateStaff('9700000001', { active: false }, owner2, ctx2));
const changed = await updateStaff(ops, { role: 'support' }, owner2, ctx2);
t('role changed', changed.role === 'support');
const off = await updateStaff(ops, { active: false }, owner2, ctx2);
t('deactivated', off.active === false);
const list = await listStaff();
t('env owner listed first and fixed', list[0]?.mobile === '9700000001' && list[0].envOwner === true, list[0]);
t('staff events', (await col.events(db).countDocuments({ entity: 'staff' })) === 4);

console.log(`b7b-crm: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
