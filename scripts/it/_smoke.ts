// Smoke test: can tsx run lib modules that use '@/...' path aliases against the dev DB,
// including modules that import next/headers (only CALLING cookies() needs a request)?
import { getDb } from '@/lib/db';
import { col, normalizeMobile } from '@/lib/models';
import { isAdminMobile } from '@/lib/auth';

const db = await getDb();
const n = await col.users(db).countDocuments({});
console.log(
  `tsx alias ok · normalize=${normalizeMobile('+91 70752 02177')} · users=${n} · db=${db.databaseName} · authImport=${typeof isAdminMobile}`,
);
process.exit(0);
