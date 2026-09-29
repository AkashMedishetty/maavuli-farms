// Create every index the app relies on, straight from INDEXES in lib/models.ts (no
// hand-kept copy to drift). Idempotent; safe to re-run.
//
//   pnpm db:init                              (the database in .env.local)
//   MONGODB_DB=maavuli_it_b1 pnpm db:init     (an isolated integration-test database)
//
// It never drops anything. Replacing an index whose options changed (e.g. the old
// deliveries {subscriptionId,date} unique index) is the platform migration's job.
import { getDb } from '@/lib/db';
import { INDEXES } from '@/lib/models';

const db = await getDb();
let created = 0;
let failed = 0;
for (const ix of INDEXES) {
  try {
    await db.collection(ix.col).createIndex(ix.spec as Record<string, 1 | -1 | '2dsphere'>, ix.options);
    created++;
  } catch (err) {
    failed++;
    console.log(`index ${ix.col} ${JSON.stringify(ix.spec)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`init-db: ${created} ensured, ${failed} failed · db=${db.databaseName}`);
process.exit(failed ? 1 : 0);
