// Load a realistic, city-wide mock dataset for testing the delivery side at scale:
// 12 riders, each owning one zone, the zones tiling Hyderabad with no overlaps, and
// ~100 customers spread across ~55 localities. Customers are created through the
// REAL checkout and payment code (createCheckoutOrder → markOrderPaid), with only
// Razorpay's network call stubbed, so plans, deliveries, pause allowances and zone
// links are exactly what a real purchase leaves behind. Today is then locked, so
// riders can sign in and see their stops immediately.
//
//   pnpm db:seed-load                          (a *_dev / *_test / … database)
//   SEED_ALLOW_DB=maavuli pnpm db:seed-load    (any other name — confirm it exactly)
//   SEED_ALLOW_DB=maavuli pnpm db:seed-load --reset   (remove everything this added)
//
// Safety:
//  · Refuses a database whose name is not test-like unless SEED_ALLOW_DB names it.
//  · Every mock customer has WhatsApp OFF. The numbers are made up; an invented
//    number can belong to a real person, and nothing here may ever message them.
//  · Idempotent: re-running reuses each customer's checkout (same idempotency key)
//    and changes nothing it already made.
//
// Seeded identities (so --reset can find them):
//   riders     9800001001 … 9800001012
//   customers  9800002001 … 9800002100
//   zones      named "HYD · …"; older zones it switched off carry seedDeactivated
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, COL, type LatLng } from '@/lib/models';
import { pointsToPolygon } from '@/lib/geo';
import { DEFAULT_OPS } from '@/lib/settings';
import { createCheckoutOrder, markOrderPaid, __setRazorpayCreateOrderForTests } from '@/lib/orders';
import { lockDay } from '@/lib/manifest';
import { customerActor, systemCtx, type OpCtx } from '@/lib/clock';
import { addDaysYMD, istInstant, istYMD } from '@/lib/cutoff';

/* ------------------------------------------------------------------ guard -- */

const dbName = (process.env.MONGODB_DB ?? '').trim();
const allowed = (process.env.SEED_ALLOW_DB ?? '').trim();
if (!/(_dev|_it_|_e2e|_test|_demo)/.test(dbName) && allowed !== dbName) {
  console.log(
    `seed-load: refusing "${dbName}". Its name does not look like test data.\n` +
      `If this database really is for testing, confirm it by name:  SEED_ALLOW_DB=${dbName} pnpm db:seed-load`,
  );
  process.exit(1);
}

const RESET = process.argv.includes('--reset');
const NO_LOCK = process.argv.includes('--no-lock'); // leave today unlocked (lock it separately)
const ZONE_PREFIX = 'HYD · ';
const RIDER_PHONES = Array.from({ length: 12 }, (_, i) => `98000010${String(i + 1).padStart(2, '0')}`);
const CUSTOMER_COUNT = 100;
const CUSTOMER_MOBILES = Array.from({ length: CUSTOMER_COUNT }, (_, i) => `9800002${String(i + 1).padStart(3, '0')}`);

const db = await getDb();

/* ------------------------------------------------------------------ reset -- */

if (RESET) {
  const riders = await col.riders(db).find({ phone: { $in: RIDER_PHONES } }).toArray();
  const riderIds = riders.map(r => r._id!);
  const runs = await col.riderRuns(db).find({ riderId: { $in: riderIds } }).toArray();
  const runIds = runs.map(r => r._id!);

  // Non-seeded customers' stops that got locked into a seeded rider's run go back to planned.
  const reverted = await col.deliveries(db).updateMany(
    { runId: { $in: runIds }, status: 'locked', mobile: { $nin: CUSTOMER_MOBILES } },
    { $set: { status: 'planned' }, $unset: { runId: '', riderId: '', seq: '', lockedAt: '' } },
  );

  const removed: Record<string, number> = {};
  // Everything keyed by the customer's mobile, in every collection that has one.
  for (const name of Object.values(COL)) {
    const r = await db.collection(name).deleteMany({ mobile: { $in: CUSTOMER_MOBILES } });
    if (r.deletedCount) removed[name] = r.deletedCount;
  }
  removed.rider_runs = (await col.riderRuns(db).deleteMany({ _id: { $in: runIds } })).deletedCount;
  removed.standing_routes = (await col.standingRoutes(db).deleteMany({ riderId: { $in: riderIds } })).deletedCount;
  removed.riders = (await col.riders(db).deleteMany({ _id: { $in: riderIds } })).deletedCount;
  removed.zones = (await col.zones(db).deleteMany({ name: { $regex: `^${ZONE_PREFIX}` } })).deletedCount;
  const restored = await col.zones(db).updateMany(
    { seedDeactivated: true } as never,
    { $set: { active: true, updatedAt: new Date() }, $unset: { seedDeactivated: '' } } as never,
  );

  console.log(`seed-load --reset (${dbName}):`);
  for (const [k, v] of Object.entries(removed)) if (v) console.log(`  removed ${String(v).padStart(4)}  ${k}`);
  console.log(`  re-planned ${reverted.modifiedCount} other customers' stops, re-activated ${restored.modifiedCount} older zone(s)`);
  process.exit(0);
}

/* ------------------------------------------------------------- randomness -- */

// Deterministic, so a re-run produces the same people at the same doors.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261008);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
function weighted<T>(pairs: readonly [T, number][]): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[pairs.length - 1]![0];
}

/* -------------------------------------------------------------- geography -- */

interface Locality {
  name: string;
  pin: string;
  at: LatLng;
}
interface Area {
  zone: string;
  rider: string;
  localities: Locality[];
}
const L = (name: string, pin: string, lat: number, lng: number): Locality => ({ name, pin, at: { lat, lng } });

const AREAS: Area[] = [
  { zone: 'Kukatpally & Miyapur', rider: 'Ravi Kumar', localities: [
    L('Kukatpally', '500072', 17.4849, 78.4138), L('KPHB Colony', '500072', 17.4933, 78.3996),
    L('Miyapur', '500049', 17.4969, 78.3548), L('Nizampet', '500090', 17.5170, 78.3830), L('Bachupally', '500090', 17.5440, 78.3870) ] },
  { zone: 'Gachibowli & Madhapur', rider: 'Srinivas Reddy', localities: [
    L('Gachibowli', '500032', 17.4401, 78.3489), L('Kondapur', '500084', 17.4690, 78.3640),
    L('Madhapur', '500081', 17.4483, 78.3915), L('HITEC City', '500081', 17.4474, 78.3762) ] },
  { zone: 'Manikonda & Tolichowki', rider: 'Mahesh Goud', localities: [
    L('Manikonda', '500089', 17.4040, 78.3870), L('Narsingi', '500075', 17.3880, 78.3560), L('Tolichowki', '500008', 17.3990, 78.4150) ] },
  { zone: 'Banjara & Jubilee Hills', rider: 'Naresh Yadav', localities: [
    L('Banjara Hills', '500034', 17.4156, 78.4347), L('Jubilee Hills', '500033', 17.4325, 78.4070),
    L('Ameerpet', '500016', 17.4375, 78.4482), L('SR Nagar', '500038', 17.4410, 78.4430) ] },
  { zone: 'Mehdipatnam & Attapur', rider: 'Venkatesh Babu', localities: [
    L('Mehdipatnam', '500028', 17.3950, 78.4400), L('Masab Tank', '500028', 17.4000, 78.4540), L('Attapur', '500048', 17.3700, 78.4300) ] },
  { zone: 'Begumpet & Sanathnagar', rider: 'Anil Kumar', localities: [
    L('Begumpet', '500016', 17.4440, 78.4660), L('Sanathnagar', '500018', 17.4560, 78.4430),
    L('Erragadda', '500018', 17.4560, 78.4320), L('Balanagar', '500037', 17.4720, 78.4410), L('Moosapet', '500018', 17.4690, 78.4250) ] },
  { zone: 'Secunderabad', rider: 'Prakash Rao', localities: [
    L('Secunderabad', '500003', 17.4399, 78.4983), L('Marredpally', '500026', 17.4440, 78.5070),
    L('Bowenpally', '500011', 17.4700, 78.4840), L('Tirumalgherry', '500015', 17.4720, 78.5070) ] },
  { zone: 'Himayatnagar & Malakpet', rider: 'Ramesh Babu', localities: [
    L('Himayatnagar', '500029', 17.4010, 78.4870), L('Abids', '500001', 17.3920, 78.4760),
    L('Koti', '500095', 17.3850, 78.4870), L('Nampally', '500001', 17.3890, 78.4690), L('Malakpet', '500036', 17.3730, 78.5000) ] },
  { zone: 'Dilsukhnagar & LB Nagar', rider: 'Kiran Kumar', localities: [
    L('Dilsukhnagar', '500060', 17.3687, 78.5247), L('Kothapet', '500035', 17.3680, 78.5450), L('LB Nagar', '500074', 17.3490, 78.5520),
    L('Saroornagar', '500035', 17.3530, 78.5320), L('Vanasthalipuram', '500070', 17.3290, 78.5660) ] },
  { zone: 'Uppal & Tarnaka', rider: 'Suresh Naidu', localities: [
    L('Uppal', '500039', 17.4050, 78.5590), L('Tarnaka', '500017', 17.4280, 78.5390), L('Habsiguda', '500007', 17.4180, 78.5450),
    L('Nacharam', '500076', 17.4300, 78.5560), L('Ramanthapur', '500013', 17.3990, 78.5300) ] },
  { zone: 'Malkajgiri & ECIL', rider: 'Raju Goud', localities: [
    L('Malkajgiri', '500047', 17.4508, 78.5358), L('Safilguda', '500047', 17.4735, 78.5468), L('Neredmet', '500056', 17.4870, 78.5320),
    L('Sainikpuri', '500094', 17.4920, 78.5530), L('AS Rao Nagar', '500062', 17.4790, 78.5590), L('ECIL', '500062', 17.4710, 78.5730) ] },
  { zone: 'Kompally & Alwal', rider: 'Sai Teja', localities: [
    L('Kompally', '500014', 17.5390, 78.4870), L('Suchitra', '500067', 17.5130, 78.4800), L('Alwal', '500010', 17.5020, 78.5100),
    L('Jeedimetla', '500055', 17.5080, 78.4500), L('Quthbullapur', '500055', 17.5180, 78.4600) ] },
];

// Customers per area: an even base, with the busier corridors a little heavier —
// real demand is never flat, and the route-load table at the end shows it.
const EXTRA: Record<string, number> = { 'Kukatpally & Miyapur': 2, 'Gachibowli & Madhapur': 2, 'Malkajgiri & ECIL': 2, 'Uppal & Tarnaka': 1 };
const BASE_PER_AREA = Math.floor((CUSTOMER_COUNT - Object.values(EXTRA).reduce((a, b) => a + b, 0)) / AREAS.length);

const mean = (ps: LatLng[]): LatLng => ({
  lat: ps.reduce((s, p) => s + p.lat, 0) / ps.length,
  lng: ps.reduce((s, p) => s + p.lng, 0) / ps.length,
});

/*
 * Zones = the Voronoi cells of the 12 area hubs, clipped to a city bounding box:
 * every point belongs to exactly ONE zone (the nearest hub), with no gaps and no
 * overlaps. Overlapping zones make "whose stop is this" depend on query order.
 * Computed in an equirectangular projection so bisectors are true at this latitude.
 */
const KX = Math.cos((17.42 * Math.PI) / 180);
type XY = { x: number; y: number };
const toXY = (p: LatLng): XY => ({ x: p.lng * KX, y: p.lat });
const toLL = (q: XY): LatLng => ({ lat: Number(q.y.toFixed(6)), lng: Number((q.x / KX).toFixed(6)) });
const BBOX = { s: 17.27, n: 17.62, w: 78.27, e: 78.74 };

function clipCloserTo(poly: XY[], a: XY, b: XY): XY[] {
  const nx = b.x - a.x, ny = b.y - a.y, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const f = (q: XY) => (q.x - mx) * nx + (q.y - my) * ny; // ≤ 0 → nearer a
  const out: XY[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!, prev = poly[(i - 1 + poly.length) % poly.length]!;
    const fc = f(cur), fp = f(prev);
    const cross = () => { const t = fp / (fp - fc); return { x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) }; };
    if (fc <= 0) { if (fp > 0) out.push(cross()); out.push(cur); }
    else if (fp <= 0) out.push(cross());
  }
  return out;
}
function voronoiCell(i: number, hubs: XY[]): LatLng[] {
  let cell: XY[] = [
    toXY({ lat: BBOX.s, lng: BBOX.w }), toXY({ lat: BBOX.s, lng: BBOX.e }),
    toXY({ lat: BBOX.n, lng: BBOX.e }), toXY({ lat: BBOX.n, lng: BBOX.w }),
  ];
  for (let j = 0; j < hubs.length; j++) if (j !== i) cell = clipCloserTo(cell, hubs[i]!, hubs[j]!);
  // GeoJSON wants the exterior ring counter-clockwise (lng = x, lat = y).
  const area = cell.reduce((s, p, k) => { const q = cell[(k + 1) % cell.length]!; return s + p.x * q.y - q.x * p.y; }, 0);
  if (area < 0) cell.reverse();
  return cell.map(toLL);
}

/* --------------------------------------------------------------- people -- */

const FIRST = ['Anitha', 'Ravi', 'Sravani', 'Mohammed', 'Priya', 'Venkat', 'Lakshmi', 'Arjun', 'Fatima', 'Suresh', 'Divya', 'Karthik',
  'Ayesha', 'Ramesh', 'Swathi', 'Imran', 'Pooja', 'Naveen', 'Kavya', 'Sanjay', 'Meera', 'Abdul', 'Harika', 'Vikram', 'Sneha',
  'Joseph', 'Bhavana', 'Rahul', 'Zainab', 'Srikanth', 'Neha', 'Anand', 'Keerthi', 'Farhan', 'Madhavi', 'Rohit', 'Deepika', 'Gopal'];
const LAST = ['Reddy', 'Rao', 'Naidu', 'Sharma', 'Khan', 'Goud', 'Varma', 'Chowdary', 'Patel', 'Kumar', 'Iyer', 'Pillai', 'Fernandes',
  'Gupta', 'Agarwal', 'Siddiqui', 'Hussain', 'Yadav', 'Shetty', 'Murthy', 'Raju', 'Ahmed', 'Joshi', 'Menon'];
const STREETS = ['Road No. 2', 'Road No. 5', 'Road No. 12', 'Main Road', 'Lane 3', 'Street No. 4', '1st Cross', '3rd Avenue',
  'Temple Street', 'Park Lane', 'MIG Colony', 'HIG Colony', 'Vivekananda Nagar', 'Gandhi Nagar', 'Sai Nagar', 'Venkateswara Colony'];
const BUILDINGS = ['Sai Residency', 'Lakshmi Enclave', 'Green Meadows', 'Sri Sai Towers', 'Vasavi Heights', 'Royal Apartments',
  'Aditya Homes', 'Lotus Residency', 'Krishna Nilayam', 'Balaji Arcade'];
const LANDMARKS = ['Opp. Ratnadeep supermarket', 'Near SBI ATM', 'Behind Hanuman temple', 'Next to Apollo Pharmacy',
  'Opp. government school', 'Near the bus stop', 'Lane beside Reliance Fresh', 'Opp. the park', 'Near the water tank',
  'Beside the church', 'Opp. the mosque', 'Near the metro pillar'];
const INSTRUCTIONS = ['Leave at the door, do not ring', 'Ring twice', 'Hand it to security at the gate',
  'Hang the bag on the door handle', 'Call on arrival', 'Leave on the shoe rack'];

function addressFor(loc: Locality): string {
  if (rand() < 0.55) {
    return `Flat ${100 * (1 + Math.floor(rand() * 5)) + 1 + Math.floor(rand() * 8)}, ${pick(BUILDINGS)}, ${pick(STREETS)}, ${loc.name}, Hyderabad ${loc.pin}`;
  }
  return `H.No. ${1 + Math.floor(rand() * 16)}-${1 + Math.floor(rand() * 9)}-${1 + Math.floor(rand() * 200)}, ${pick(STREETS)}, ${loc.name}, Hyderabad ${loc.pin}`;
}
/** A doorstep within ~400 m of the locality centre. */
function jitter(p: LatLng): LatLng {
  const dLat = (rand() - 0.5) * 0.0072;
  const dLng = (rand() - 0.5) * 0.0076;
  return { lat: Number((p.lat + dLat).toFixed(6)), lng: Number((p.lng + dLng).toFixed(6)) };
}

/* ------------------------------------------------------------------ build -- */

const now = new Date();
const today = istYMD(now);
const yesterday = addDaysYMD(today, -1);
const tag = { kind: 'system' as const, id: 'seed-load' };
const log: string[] = [];

// settings — only if missing (never overwrite a value someone edited)
if (!(await col.settings(db).findOne({ _id: 'ops' }))) {
  await col.settings(db).insertOne({ _id: 'ops', ...DEFAULT_OPS, updatedAt: now, updatedBy: tag });
  log.push('settings: defaults written');
}

// staff — the two test staff from docs/TESTING.md, for the permission tests
for (const s of [
  { mobile: '9800000011', name: 'Dev Ops', role: 'ops' as const },
  { mobile: '9800000012', name: 'Dev Support', role: 'support' as const },
]) {
  const r = await col.staff(db).updateOne(
    { mobile: s.mobile },
    { $set: { name: s.name, role: s.role, active: true, updatedAt: now }, $setOnInsert: { mobile: s.mobile, createdAt: now } },
    { upsert: true },
  );
  if (r.upsertedCount) log.push(`staff: ${s.name} (${s.role}, ${s.mobile})`);
}

// older zones would overlap the new tiling — switch them off (reversible with --reset)
const off = await col.zones(db).updateMany(
  { active: true, name: { $not: { $regex: `^${ZONE_PREFIX}` } } },
  { $set: { active: false, updatedAt: now, seedDeactivated: true } } as never,
);
if (off.modifiedCount) log.push(`zones: switched off ${off.modifiedCount} older overlapping zone(s)`);

// riders + their zones
const hubs = AREAS.map(a => mean(a.localities.map(l => l.at)));
const hubXY = hubs.map(toXY);
const riderIdByZone = new Map<string, ObjectId>();
for (let i = 0; i < AREAS.length; i++) {
  const a = AREAS[i]!;
  const phone = RIDER_PHONES[i]!;
  const res = await col.riders(db).findOneAndUpdate(
    { phone },
    {
      $set: { name: a.rider, active: true, startLocation: hubs[i]!, note: `Mock rider for ${a.zone}`, updatedAt: now },
      $setOnInsert: { phone, createdAt: now },
    },
    { upsert: true, returnDocument: 'after', includeResultMetadata: true },
  );
  const riderId = res.value!._id!;
  riderIdByZone.set(a.zone, riderId);
  if (!res.lastErrorObject?.updatedExisting) log.push(`rider: ${a.rider} (${phone}) → ${a.zone}`);

  const points = voronoiCell(i, hubXY);
  await col.zones(db).updateOne(
    { name: ZONE_PREFIX + a.zone },
    {
      $set: {
        name: ZONE_PREFIX + a.zone,
        active: true,
        shape: { kind: 'polygon', points },
        geometry: pointsToPolygon(points),
        riderId,
        note: 'Mock zone (seed-load) — not a confirmed service area',
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

// customers — through the real checkout + payment, Razorpay stubbed
__setRazorpayCreateOrderForTests(async ({ amountPaise, receipt }) => ({
  id: `order_seed_${new ObjectId().toHexString()}`,
  entity: 'order',
  amount: amountPaise,
  currency: 'INR',
  receipt,
  status: 'created',
}));

const plan = () => ({
  kind: weighted<'cow' | 'buffalo'>([['cow', 55], ['buffalo', 45]]),
  quantityId: weighted([['one', 60], ['half', 40]]),
  tenureId: weighted([['1m', 35], ['3m', 30], ['6m', 20], ['1y', 15]]),
});

let made = 0, reused = 0, second = 0, startTomorrow = 0;
let n = 0;

// 1. Generate every customer IN ORDER, so the deterministic random stream (and so
//    each person, door and plan) is identical however the checkouts are scheduled.
interface Job { mobile: string; details: Parameters<typeof createCheckoutOrder>[0]['details']; plans: ReturnType<typeof plan>[]; at: Date[]; newToday: boolean }
const jobs: Job[] = [];
for (const a of AREAS) {
  const count = BASE_PER_AREA + (EXTRA[a.zone] ?? 0);
  for (let k = 0; k < count; k++) {
    const mobile = CUSTOMER_MOBILES[n++]!;
    const loc = a.localities[k % a.localities.length]!;
    const details = {
      name: `${pick(FIRST)} ${pick(LAST)}`,
      address: addressFor(loc),
      landmark: pick(LANDMARKS),
      ...(rand() < 0.45 ? { instructions: pick(INSTRUCTIONS) } : {}),
      location: jitter(loc.at),
    };
    // Most bought yesterday morning (first delivery today); one in ten bought this
    // morning, before the cut-off (first delivery tomorrow) — the new sign-ups.
    const newToday = rand() < 0.1;
    const buyDay = newToday ? today : yesterday;
    const plans = [plan()];
    if (rand() < 0.08) {
      plans.push({ ...plan(), kind: plans[0]!.kind === 'cow' ? 'buffalo' : 'cow' }); // both milks, same door
    }
    const at = plans.map(() =>
      istInstant(buyDay, `${String(9 + Math.floor(rand() * 4)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}`),
    );
    jobs.push({ mobile, details, plans, at, newToday });
  }
}

// 2. Check out + pay, several customers at a time (one customer's plans stay in
//    order). Every step is idempotent, so a re-run after an interruption resumes.
async function runJob(j: Job): Promise<void> {
  for (let p = 0; p < j.plans.length; p++) {
    const ctx: OpCtx = { now: j.at[p]!, actor: customerActor(j.mobile) };
    const key = `seed-load-${j.mobile}-${p}`;
    const existing = await col.orders(db).countDocuments({ mobile: j.mobile, idempotencyKey: key });
    const r = await createCheckoutOrder(
      { mobile: j.mobile, purpose: 'new', ...j.plans[p]!, details: j.details, useCredit: false, whatsappOptIn: false, idempotencyKey: key },
      ctx,
    );
    if (r.order.status !== 'paid') {
      await markOrderPaid(r.order._id, { razorpayPaymentId: `pay_seed_${r.order._id.toHexString()}`, source: 'verify' }, ctx);
    }
    if (existing) reused++;
    else made++;
    if (p === 1) second++;
    if (p === 0 && j.newToday) startTomorrow++;
  }
}
const CONCURRENCY = 8;
let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++]!;
      await runJob(j);
      if (++done % 10 === 0) console.log(`  … ${done}/${jobs.length} customers`);
    }
  }),
);
__setRazorpayCreateOrderForTests(undefined);
log.push(`customers: ${n} (${made} plan(s) created, ${reused} already there; ${second} with both milks; ${startTomorrow} start tomorrow)`);

// lock today, as the 4 PM job would have done yesterday, so riders see stops now
if (!NO_LOCK) {
  const lock = await lockDay(today, systemCtx(istInstant(yesterday, '16:05'), 'seed-load'));
  log.push(`locked ${today}: ${JSON.stringify(lock).slice(0, 160)}`);
}

/* ----------------------------------------------------------------- report -- */

const runs = await col.riderRuns(db).find({ date: today }).toArray();
const riders = await col.riders(db).find({}).toArray();
const nameOf = new Map(riders.map(r => [r._id!.toHexString(), `${r.name} (${r.phone ?? '—'})`]));
console.log(`seed-load (${dbName}):\n  ${log.join('\n  ')}\n`);
console.log(`Today's runs (${today}) — stops and litres per rider:`);
const rows = runs
  .map(r => ({
    who: r.riderId ? nameOf.get(r.riderId.toHexString()) ?? String(r.riderId) : 'UNASSIGNED (no rider on that zone)',
    stops: r.load?.stops ?? 0,
    cow: r.load?.cowLitres ?? 0,
    buf: r.load?.buffaloLitres ?? 0,
  }))
  .sort((x, y) => y.stops - x.stops);
for (const r of rows) {
  console.log(`  ${r.who.padEnd(34)} ${String(r.stops).padStart(3)} stops   cow ${String(r.cow).padStart(5)} L   buffalo ${String(r.buf).padStart(5)} L`);
}
process.exit(0);
