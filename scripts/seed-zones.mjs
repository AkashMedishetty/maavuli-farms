// Seed a delivery zone so the geo path can be exercised.
//
//   node --env-file-if-exists=.env.local scripts/seed-zones.mjs "Name" <lat> <lng> <radiusM>
//   node --env-file-if-exists=.env.local scripts/seed-zones.mjs        (test default)
//
// Geometry is derived here the same way the admin route derives it — via
// circleToPolygon — so a seeded zone and an admin-drawn zone are byte-identical in
// shape. Never hand-write a GeoJSON ring: wound the wrong way, MongoDB matches the
// COMPLEMENT of the area, which fails OPEN.
import { MongoClient } from 'mongodb';
import { circleToPolygon } from '../lib/geo.ts';

const [name = 'TEST ZONE - not a confirmed service area', lat = '17.4735', lng = '78.5468', radius = '6000'] =
  process.argv.slice(2);

const uri = (process.env.MONGODB_URI ?? '').trim();
const dbName = (process.env.MONGODB_DB ?? '').trim();
if (!uri || !dbName) {
  console.error('seed-zones: missing env: ' + [!uri && 'MONGODB_URI', !dbName && 'MONGODB_DB'].filter(Boolean).join(', '));
  process.exit(1);
}

const centre = { lat: Number(lat), lng: Number(lng) };
const radiusM = Number(radius);
const geometry = circleToPolygon(centre, radiusM);

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);
const now = new Date();
await db.collection('zones').updateOne(
  { name },
  {
    $set: { name, active: true, shape: { kind: 'circle', centre, radiusM }, geometry, updatedAt: now },
    $setOnInsert: { createdAt: now },
  },
  { upsert: true },
);
console.log(`seed-zones: "${name}" active — ${(radiusM / 1000).toFixed(1)}km around ${centre.lat}, ${centre.lng}`);
const all = await db.collection('zones').find({ active: true }).toArray();
console.log(`seed-zones: ${all.length} active zone(s) total`);
await client.close();
