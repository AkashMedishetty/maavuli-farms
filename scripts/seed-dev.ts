// Seed a development / e2e database with the minimum a working platform needs:
// ops settings, three delivery zones around Safilguda (Hyderabad), three riders
// (one per zone), and two staff numbers. Idempotent: re-running updates in place.
//
//   pnpm db:seed-dev                              (the database in .env.local)
//   MONGODB_DB=maavuli_e2e pnpm db:seed-dev       (an isolated one)
//
// Refuses to run against a database whose name does not look like dev/test data,
// so it can never be pointed at production by accident.
import { getDb } from '@/lib/db';
import { col } from '@/lib/models';
import { circleToPolygon } from '@/lib/geo';
import { DEFAULT_OPS } from '@/lib/settings';

const dbName = (process.env.MONGODB_DB ?? '').trim();
if (!/(_dev|_it_|_e2e|_test|_demo)/.test(dbName)) {
  console.log(`seed-dev: refusing to seed "${dbName}" — the name must contain _dev, _it_, _e2e, _test or _demo`);
  process.exit(1);
}

const db = await getDb();
const now = new Date();
const changes: string[] = [];

// ---- settings (only fills what is missing; never overwrites an edited value) ----
const existing = await col.settings(db).findOne({ _id: 'ops' });
if (!existing) {
  await col.settings(db).insertOne({ _id: 'ops', ...DEFAULT_OPS, updatedAt: now, updatedBy: { kind: 'system', id: 'seed-dev' } });
  changes.push('settings: defaults written');
}

// ---- riders ----
const RIDERS = [
  { name: 'Ravi (dev rider)', phone: '9800000001', start: { lat: 17.4735, lng: 78.5468 } },
  { name: 'Suresh (dev rider)', phone: '9800000002', start: { lat: 17.4735, lng: 78.5468 } },
  { name: 'Lakshmi (dev rider)', phone: '9800000003', start: { lat: 17.4735, lng: 78.5468 } },
];
const riderIds = [];
for (const r of RIDERS) {
  const res = await col.riders(db).findOneAndUpdate(
    { phone: r.phone },
    {
      $set: { name: r.name, active: true, startLocation: r.start, updatedAt: now },
      $setOnInsert: { phone: r.phone, createdAt: now },
    },
    { upsert: true, returnDocument: 'after', includeResultMetadata: true },
  );
  riderIds.push(res.value!._id!);
  if (!res.lastErrorObject?.updatedExisting) changes.push(`rider: ${r.name} (${r.phone})`);
}

// ---- zones: three 1.8 km circles around the Safilguda locality, one per rider ----
const ZONES = [
  { name: 'DEV Safilguda', centre: { lat: 17.4735, lng: 78.5468 } },
  { name: 'DEV Malkajgiri', centre: { lat: 17.4508, lng: 78.5358 } },
  { name: 'DEV Neredmet', centre: { lat: 17.4870, lng: 78.5320 } },
];
for (let i = 0; i < ZONES.length; i++) {
  const z = ZONES[i]!;
  const radiusM = 1800;
  const res = await col.zones(db).updateOne(
    { name: z.name },
    {
      $set: {
        name: z.name,
        active: true,
        shape: { kind: 'circle', centre: z.centre, radiusM },
        geometry: circleToPolygon(z.centre, radiusM),
        riderId: riderIds[i]!,
        note: 'Development zone — not a confirmed service area',
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  if (res.upsertedCount) changes.push(`zone: ${z.name}`);
}

// ---- staff ----
const STAFF = [
  { mobile: '9800000011', name: 'Dev Ops', role: 'ops' as const },
  { mobile: '9800000012', name: 'Dev Support', role: 'support' as const },
];
for (const s of STAFF) {
  const res = await col.staff(db).updateOne(
    { mobile: s.mobile },
    { $set: { name: s.name, role: s.role, active: true, updatedAt: now }, $setOnInsert: { mobile: s.mobile, createdAt: now } },
    { upsert: true },
  );
  if (res.upsertedCount) changes.push(`staff: ${s.name} (${s.role}, ${s.mobile})`);
}

console.log(changes.length ? `seed-dev (${dbName}):\n  ${changes.join('\n  ')}` : `seed-dev (${dbName}): already seeded, nothing changed`);
process.exit(0);
