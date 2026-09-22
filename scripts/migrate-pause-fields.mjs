// scripts/migrate-pause-fields.mjs
//
// One-time migration to add pauseAllowanceDays and pauseUsedDays to existing
// subscriptions that were created before the pause feature was added.
//
// Run:  node scripts/migrate-pause-fields.mjs           (does the migration)
//       node scripts/migrate-pause-fields.mjs --dry-run (shows what would be updated)

import { MongoClient } from 'mongodb';

const uri = (process.env.MONGODB_URI ?? '').trim();
const dbName = (process.env.MONGODB_DB ?? '').trim();

function fail(msg) {
  console.error(`migrate-pause-fields: ${msg}`);
  process.exit(1);
}

if (!uri || !dbName) {
  const missing = [!uri && 'MONGODB_URI', !dbName && 'MONGODB_DB'].filter(Boolean);
  fail(`missing env: ${missing.join(', ')}`);
}

/**
 * Calculate pause allowance based on subscription tenure.
 * Must match lib/subscriptions.ts logic.
 */
function calculatePauseAllowance(daysTotal) {
  if (daysTotal <= 30) return 3;
  if (daysTotal <= 90) return 20;
  if (daysTotal <= 180) return 25;
  return 30; // 1 year+
}

async function migrate(dryRun = false) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();

  try {
    const db = client.db(dbName);
    const subscriptions = db.collection('subscriptions');

    // Find subscriptions that don't have the new fields
    const needsMigration = await subscriptions
      .find({
        $or: [
          { pauseAllowanceDays: { $exists: false } },
          { pauseUsedDays: { $exists: false } }
        ]
      })
      .toArray();

    if (needsMigration.length === 0) {
      console.log('migrate-pause-fields: no subscriptions need migration');
      return;
    }

    console.log(`migrate-pause-fields: found ${needsMigration.length} subscription(s) to update`);

    if (dryRun) {
      console.log('\nDRY RUN - would update:');
      for (const sub of needsMigration) {
        const allowance = calculatePauseAllowance(sub.daysTotal);
        console.log(`  ${sub._id}: daysTotal=${sub.daysTotal} -> pauseAllowanceDays=${allowance}, pauseUsedDays=0`);
      }
      console.log('\nRe-run without --dry-run to apply these changes.');
      return;
    }

    let updated = 0;
    for (const sub of needsMigration) {
      const allowance = calculatePauseAllowance(sub.daysTotal);
      await subscriptions.updateOne(
        { _id: sub._id },
        {
          $set: {
            pauseAllowanceDays: allowance,
            pauseUsedDays: 0
          }
        }
      );
      updated += 1;
      console.log(`  ${sub._id}: set pauseAllowanceDays=${allowance}, pauseUsedDays=0`);
    }

    console.log(`\nmigrate-pause-fields: updated ${updated} subscription(s)`);
  } finally {
    await client.close();
  }
}

const isDryRun = process.argv.includes('--dry-run');

migrate(isDryRun).catch((err) => {
  fail(err?.message ?? String(err));
});
