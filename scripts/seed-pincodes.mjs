// scripts/seed-pincodes.mjs — upsert service-area pincodes. Never invents values.
//
// Run with:  node scripts/seed-pincodes.mjs 560001,560002 "560003,Indiranagar"
//        or: node scripts/seed-pincodes.mjs           (reads data/pincodes.txt)
//        or: pnpm db:seed-pincodes -- 560001,560002
//
// Input sources, in order:
//   1. argv — one or more comma-separated tokens, each "pincode" or "pincode,area"
//   2. data/pincodes.txt — one entry per line, same "pincode" or "pincode,area" form
//
// The client has NOT supplied a pincode list. This script must therefore NEVER
// contain hardcoded pincode values. With no input it prints that none were supplied
// and exits 0 WITHOUT writing anything — an empty service area is the honest default,
// and inventing coverage would promise deliveries we cannot make.

import { MongoClient } from 'mongodb';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data', 'pincodes.txt');

function fail(msg) {
  console.error(`seed-pincodes: ${msg}`);
  process.exit(1);
}

/** Parse one raw token into { pincode, area? } or null if it is not a valid 6-digit pincode. */
function parseEntry(raw) {
  const [pinPart, ...areaParts] = raw.split(',');
  const pincode = (pinPart ?? '').trim();
  if (!/^\d{6}$/.test(pincode)) return null;
  const area = areaParts.join(',').trim();
  return area ? { pincode, area } : { pincode };
}

/** Collect raw tokens from argv, else from data/pincodes.txt. Returns [] when neither has content. */
async function collectTokens() {
  // Each argv token is a whole entry ("560001" or "560003,Indiranagar"); do NOT split
  // on comma here or the "pincode,area" pairing is lost. parseEntry handles the comma.
  const argvTokens = process.argv.slice(2).map((t) => t.trim()).filter(Boolean);
  if (argvTokens.length > 0) return argvTokens;

  try {
    const text = await readFile(DATA_FILE, 'utf8');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function main() {
  const tokens = await collectTokens();

  if (tokens.length === 0) {
    console.log(
      'seed-pincodes: no pincodes supplied (empty argv and no data/pincodes.txt). ' +
        'Nothing written — the service area stays empty. Provide a list to seed it.',
    );
    process.exit(0);
  }

  const entries = [];
  const skipped = [];
  for (const token of tokens) {
    const parsed = parseEntry(token);
    if (parsed) entries.push(parsed);
    else skipped.push(token);
  }

  for (const s of skipped) console.warn(`seed-pincodes: skipping invalid entry "${s}" (need a 6-digit pincode)`);

  if (entries.length === 0) {
    console.log('seed-pincodes: no valid 6-digit pincodes in the supplied input. Nothing written.');
    process.exit(0);
  }

  const uri = (process.env.MONGODB_URI ?? '').trim();
  const dbName = (process.env.MONGODB_DB ?? '').trim();
  if (!uri || !dbName) {
    const missing = [!uri && 'MONGODB_URI', !dbName && 'MONGODB_DB'].filter(Boolean);
    fail(`missing env: ${missing.join(', ')}`);
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const db = client.db(dbName);
    const pincodes = db.collection('pincodes');
    let upserted = 0;
    for (const e of entries) {
      const set = { active: true, ...(e.area ? { area: e.area } : {}) };
      await pincodes.updateOne(
        { pincode: e.pincode },
        { $set: set, $setOnInsert: { pincode: e.pincode } },
        { upsert: true },
      );
      upserted += 1;
      console.log(`+ ${e.pincode}${e.area ? ` (${e.area})` : ''} active`);
    }
    console.log(`seed-pincodes: done — ${upserted} upserted, ${skipped.length} skipped`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  fail(err?.message ?? String(err));
});
