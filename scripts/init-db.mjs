// scripts/init-db.mjs — create every index the app relies on. Idempotent; safe to re-run.
//
// Run with:  node scripts/init-db.mjs   (or: pnpm db:init)
//
// A .mjs script cannot import the TypeScript lib/models.ts, so the index list below
// is DUPLICATED from `INDEXES` in lib/models.ts and MUST BE KEPT IN SYNC BY HAND.
// If you add or change an index there, mirror it here (and vice versa). Verified by
// eye to match lib/models.ts at time of writing.

import { MongoClient } from 'mongodb';

// ---- collection names (mirror of COL in lib/models.ts) ----
const COL = {
  users: 'users',
  otps: 'otps',
  sessions: 'sessions',
  orders: 'orders',
  subscriptions: 'subscriptions',
  deliveries: 'deliveries',
  pincodes: 'pincodes',
  webhookEvents: 'webhook_events',
};

// ---- KEEP IN SYNC with INDEXES in lib/models.ts ----
const INDEXES = [
  { col: COL.users, spec: { mobile: 1 }, options: { unique: true } },
  { col: COL.otps, spec: { mobile: 1 }, options: {} },
  { col: COL.otps, spec: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  { col: COL.sessions, spec: { token: 1 }, options: { unique: true } },
  { col: COL.sessions, spec: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  { col: COL.orders, spec: { razorpayOrderId: 1 }, options: { unique: true } },
  { col: COL.orders, spec: { mobile: 1, createdAt: -1 }, options: {} },
  { col: COL.subscriptions, spec: { mobile: 1, status: 1 }, options: {} },
  { col: COL.deliveries, spec: { date: 1, pincode: 1 }, options: {} },
  { col: COL.deliveries, spec: { subscriptionId: 1, date: 1 }, options: { unique: true } },
  { col: COL.pincodes, spec: { pincode: 1 }, options: { unique: true } },
  { col: COL.webhookEvents, spec: { eventId: 1 }, options: { unique: true } },
];

const uri = (process.env.MONGODB_URI ?? '').trim();
const dbName = (process.env.MONGODB_DB ?? '').trim();

function fail(msg) {
  console.error(`init-db: ${msg}`);
  process.exit(1);
}

if (!uri || !dbName) {
  const missing = [!uri && 'MONGODB_URI', !dbName && 'MONGODB_DB'].filter(Boolean);
  fail(`missing env: ${missing.join(', ')}`);
}

// createIndex is itself idempotent when the spec+options are unchanged, and we
// detect the "already present" case so re-runs print an honest status.
async function main() {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const db = client.db(dbName);
    let created = 0;
    let existing = 0;

    for (const ix of INDEXES) {
      const collection = db.collection(ix.col);
      const before = await collection.indexExists(nameOf(ix.spec)).catch(() => false);
      const name = await collection.createIndex(ix.spec, ix.options);
      const already = before === true || before === name;
      if (already) {
        existing += 1;
        console.log(`= ${ix.col}.${name} already present`);
      } else {
        created += 1;
        console.log(`+ ${ix.col}.${name} created`);
      }
    }

    console.log(`init-db: done — ${created} created, ${existing} already present, ${INDEXES.length} total`);
  } finally {
    await client.close();
  }
}

// Reconstruct Mongo's default index name (field1_dir1_field2_dir2...) so we can
// tell "created" from "already present" before calling createIndex.
function nameOf(spec) {
  return Object.entries(spec)
    .map(([k, v]) => `${k}_${v}`)
    .join('_');
}

main().catch((err) => {
  fail(err?.message ?? String(err));
});
