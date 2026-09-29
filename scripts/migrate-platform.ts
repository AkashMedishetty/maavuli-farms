// Platform data migration — idempotent, DRY-RUN by default.
//
//   pnpm db:migrate-platform            prints what WOULD change (no writes)
//   pnpm db:migrate-platform --apply    performs the writes
//   MONGODB_DB=maavuli_it_b1 pnpm db:migrate-platform --apply
//
// Steps (each safe to re-run; a second --apply reports 0, except step 5 keeps
// counting subscriptions whose pin is outside every active zone — they get a stopKey
// but no zoneId until ops draws a zone around them):
//  1. deliveries: legacy 'scheduled' → 'planned' (date >= today IST) / 'unconfirmed' (past);
//     'skipped' | 'failed' → 'not_delivered' with reason 'other', fault 'unknown'
//  2. deliveries: source 'plan' where missing
//  3. drop the old unique index {subscriptionId:1,date:1}, then ensure every INDEXES entry
//  4. subscriptions: legacy 'paused' → 'active'
//  5. subscriptions: stopKey + zoneId where a location exists and they are missing
//  6. orders: purpose 'new' where missing
//
// Order matters: source is backfilled BEFORE the new {subscriptionId,date,source}
// unique index is created, so legacy rows cannot collide on a missing field.
import { getDb } from '@/lib/db';
import { col, COL, INDEXES, stopKeyOf } from '@/lib/models';
import { istYMD } from '@/lib/cutoff';
import { zoneForPoint } from '@/lib/serviceability';
import { recordEvent } from '@/lib/events';
import { systemCtx } from '@/lib/clock';

const apply = process.argv.includes('--apply');
const db = await getDb();
const ctx = systemCtx(new Date(), 'migrate-platform');
const today = istYMD(ctx.now);
const report: Record<string, number> = {};

async function step(name: string, count: () => Promise<number>, run: () => Promise<number>): Promise<void> {
  const n = await count();
  report[name] = n;
  if (apply && n > 0) {
    const done = await run();
    report[name] = done;
  }
  console.log(`${apply ? 'applied' : 'would change'} ${String(report[name]).padStart(6)}  ${name}`);
}

const deliveries = col.deliveries(db);

await step(
  'deliveries scheduled (future) → planned',
  () => deliveries.countDocuments({ status: 'scheduled', date: { $gte: today } }),
  async () =>
    (await deliveries.updateMany({ status: 'scheduled', date: { $gte: today } }, { $set: { status: 'planned', updatedAt: ctx.now } }))
      .modifiedCount,
);
await step(
  'deliveries scheduled (past) → unconfirmed',
  () => deliveries.countDocuments({ status: 'scheduled', date: { $lt: today } }),
  async () =>
    (await deliveries.updateMany({ status: 'scheduled', date: { $lt: today } }, { $set: { status: 'unconfirmed', updatedAt: ctx.now } }))
      .modifiedCount,
);
await step(
  'deliveries skipped|failed → not_delivered (other/unknown)',
  () => deliveries.countDocuments({ status: { $in: ['skipped', 'failed'] } }),
  async () =>
    (
      await deliveries.updateMany(
        { status: { $in: ['skipped', 'failed'] } },
        { $set: { status: 'not_delivered', reason: 'other', fault: 'unknown', updatedAt: ctx.now } },
      )
    ).modifiedCount,
);
await step(
  "deliveries source missing → 'plan'",
  () => deliveries.countDocuments({ source: { $exists: false } }),
  async () => (await deliveries.updateMany({ source: { $exists: false } }, { $set: { source: 'plan' } })).modifiedCount,
);

// ---- indexes ---------------------------------------------------------------
const existing = await db
  .collection(COL.deliveries)
  .listIndexes()
  .toArray()
  .catch(() => [] as { name?: string; key?: Record<string, unknown> }[]);
const old = existing.find(ix => {
  const k = Object.keys(ix.key ?? {});
  return k.length === 2 && k[0] === 'subscriptionId' && k[1] === 'date';
});
report['drop old deliveries {subscriptionId,date} index'] = old ? 1 : 0;
if (old?.name && apply) await db.collection(COL.deliveries).dropIndex(old.name);
console.log(`${apply ? 'applied' : 'would change'} ${String(old ? 1 : 0).padStart(6)}  drop old deliveries {subscriptionId,date} index`);

let ensured = 0;
let failed = 0;
if (apply) {
  for (const ix of INDEXES) {
    try {
      await db.collection(ix.col).createIndex(ix.spec as Record<string, 1 | -1 | '2dsphere'>, ix.options);
      ensured++;
    } catch (err) {
      failed++;
      console.log(`  index ${ix.col} ${JSON.stringify(ix.spec)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
console.log(apply ? `ensured ${ensured} indexes, ${failed} failed` : `would ensure ${INDEXES.length} indexes`);

// ---- subscriptions -----------------------------------------------------------
const subs = col.subscriptions(db);
await step(
  'subscriptions paused → active',
  () => subs.countDocuments({ status: 'paused' }),
  async () => {
    const rows = await subs.find({ status: 'paused' }).toArray();
    let n = 0;
    for (const s of rows) {
      const r = await subs.updateOne({ _id: s._id, status: 'paused' }, { $set: { status: 'active' } });
      if (r.modifiedCount) {
        n++;
        await recordEvent(ctx, {
          entity: 'subscription',
          entityId: s._id!.toHexString(),
          type: 'subscription.migrated',
          from: 'paused',
          to: 'active',
          mobile: s.mobile,
        }, db);
      }
    }
    return n;
  },
);

const needGeo = { location: { $exists: true }, $or: [{ stopKey: { $exists: false } }, { zoneId: { $exists: false } }] };
await step(
  'subscriptions stopKey/zoneId backfill',
  () => subs.countDocuments(needGeo),
  async () => {
    const rows = await subs.find(needGeo).toArray();
    let n = 0;
    for (const s of rows) {
      if (!s.location) continue;
      const set: Record<string, unknown> = {};
      if (!s.stopKey) set.stopKey = stopKeyOf(s.mobile, s.location);
      if (!s.zoneId) {
        const z = await zoneForPoint(s.location);
        if (z?._id) set.zoneId = z._id;
      }
      if (Object.keys(set).length) {
        await subs.updateOne({ _id: s._id }, { $set: set });
        if (set.stopKey) await deliveries.updateMany({ subscriptionId: s._id, stopKey: { $exists: false } }, { $set: { stopKey: set.stopKey as string } });
        n++;
      }
    }
    return n;
  },
);

const orders = col.orders(db);
await step(
  "orders purpose missing → 'new'",
  () => orders.countDocuments({ purpose: { $exists: false } }),
  async () => (await orders.updateMany({ purpose: { $exists: false } }, { $set: { purpose: 'new' } })).modifiedCount,
);

console.log(`\nmigrate-platform ${apply ? 'APPLIED' : 'DRY RUN (pass --apply to write)'} · db=${db.databaseName}`);
process.exit(failed ? 1 : 0);
