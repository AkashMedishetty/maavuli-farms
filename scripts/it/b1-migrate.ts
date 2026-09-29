// B1 integration test for scripts/migrate-platform.ts: seeds legacy rows, runs the
// migration dry-run (must write nothing), then --apply twice (second run must change
// nothing), and checks every mapping.
//
//   MONGODB_DB=maavuli_it_b1 pnpm run it scripts/it/b1-migrate.ts
import { execFileSync } from 'node:child_process';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, COL } from '@/lib/models';

const db = await getDb();
if (!db.databaseName.startsWith('maavuli_it_')) {
  console.error(`refusing to run against ${db.databaseName}`);
  process.exit(2);
}
let pass = 0;
let fail = 0;
const ok = (name: string, c: boolean, d = '') => {
  if (c) pass++;
  else fail++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${d ? ` — ${d}` : ''}`);
};

const mobile = `92${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const subId = new ObjectId();
const orderId = new ObjectId();
const base = { subscriptionId: subId, mobile, kind: 'cow' as const, litres: 1, pincode: '500001' };
// legacy rows: no `source`, legacy statuses. Legacy writes go through the raw collection.
const raw = db.collection(COL.deliveries);
await raw.insertMany([
  { ...base, date: '2099-01-01', status: 'scheduled' },
  { ...base, date: '2000-01-01', status: 'scheduled' },
  { ...base, date: '2000-01-02', status: 'skipped' },
  { ...base, date: '2000-01-03', status: 'failed' },
]);
await db.collection(COL.subscriptions).insertOne({
  _id: subId, orderId, mobile, kind: 'cow', qtyNum: 1, qtyDen: 1, startDate: '2000-01-01', endDate: '2099-01-01',
  daysTotal: 30, daysDelivered: 0, daysPaused: 0, pauseAllowanceDays: 3, pauseUsedDays: 0, status: 'paused',
  pincode: '500001', location: { lat: 17.386, lng: 78.487 }, createdAt: new Date(),
});
await db.collection(COL.orders).insertOne({
  _id: orderId, razorpayOrderId: `order_legacy_${orderId.toHexString()}`, mobile, kind: 'cow', quantityId: 'one',
  tenureId: '1m', amountPaise: 345000, perLitrePaise: 11500, days: 30, litres: 30, pincode: '500001', status: 'paid', createdAt: new Date(),
});
// the old unique index the migration must drop (only if absent: re-runs of this test)
const hasOld = (await raw.listIndexes().toArray()).some(ix => JSON.stringify(ix.key) === '{"subscriptionId":1,"date":1}');
if (!hasOld) await raw.createIndex({ subscriptionId: 1, date: 1 }, { unique: true });

const run = (...args: string[]) =>
  execFileSync('pnpm', ['-s', 'run', 'db:migrate-platform', ...args], { env: process.env, encoding: 'utf8' });

const dry = run();
ok('dry run says DRY RUN', dry.includes('DRY RUN'));
ok('dry run wrote nothing', (await raw.countDocuments({ subscriptionId: subId, source: { $exists: false } })) === 4);

run('--apply');
const rows = await col.deliveries(db).find({ subscriptionId: subId }).toArray();
const by = (d: string) => rows.find(r => r.date === d);
ok('future scheduled → planned', by('2099-01-01')?.status === 'planned');
ok('past scheduled → unconfirmed', by('2000-01-01')?.status === 'unconfirmed');
ok('skipped → not_delivered other/unknown', by('2000-01-02')?.status === 'not_delivered' && by('2000-01-02')?.reason === 'other' && by('2000-01-02')?.fault === 'unknown');
ok('failed → not_delivered other/unknown', by('2000-01-03')?.status === 'not_delivered' && by('2000-01-03')?.fault === 'unknown');
ok("source 'plan' backfilled", rows.every(r => r.source === 'plan'));
const idx = await raw.listIndexes().toArray();
ok('old {subscriptionId,date} index dropped', !idx.some(ix => JSON.stringify(ix.key) === '{"subscriptionId":1,"date":1}'));
ok('new {subscriptionId,date,source} unique index present', idx.some(ix => JSON.stringify(ix.key) === '{"subscriptionId":1,"date":1,"source":1}' && ix.unique === true));
const s = await col.subscriptions(db).findOne({ _id: subId });
ok('paused → active', s?.status === 'active', s?.status);
ok('stopKey backfilled', s?.stopKey === `${mobile}@17.38600,78.48700`, s?.stopKey);
ok('zoneId backfilled (pin inside the b1-it-zone)', !!s?.zoneId);
ok("order purpose → 'new'", (await col.orders(db).findOne({ _id: orderId }))?.purpose === 'new');

const second = run('--apply');
const nonZero = second.split('\n').filter(l => /^applied\s+[1-9]/.test(l));
ok('second --apply changes nothing', nonZero.length === 0, nonZero.join(' | '));

console.log(`\nb1-migrate: ${pass} passed, ${fail} failed · db=${db.databaseName}`);
process.exit(fail ? 1 : 0);
