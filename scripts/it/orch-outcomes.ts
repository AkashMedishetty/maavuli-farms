// Integration test: proof flags — who gets flagged, and ops clearing a flag.
//   MONGODB_DB=maavuli_it_orch pnpm db:init
//   MONGODB_DB=maavuli_it_orch pnpm run it scripts/it/orch-outcomes.ts
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, type Delivery } from '@/lib/models';
import { riderActor, staffActor, type OpCtx } from '@/lib/clock';
import { clearProofFlag, markDelivered } from '@/lib/outcomes';

if (!process.env.MONGODB_DB?.startsWith('maavuli_it_')) {
  console.log('refusing to run: MONGODB_DB must be an isolated maavuli_it_* database');
  process.exit(1);
}
let passed = 0;
let failed = 0;
function t(name: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const db = await getDb();
const now = new Date('2031-03-03T01:30:00Z');
const riderCtx: OpCtx = { now, actor: riderActor('9830000001') };
const staffCtx: OpCtx = { now, actor: staffActor('9830000011') };

async function row(): Promise<ObjectId> {
  const d: Delivery = {
    subscriptionId: new ObjectId(),
    mobile: '9830000101',
    date: '2031-03-03',
    kind: 'cow',
    litres: 1,
    pincode: '500047',
    status: 'out_for_delivery',
    source: 'plan',
    snapshot: { name: 'Test', address: 'House 1, Street', location: { lat: 17.47, lng: 78.54 } },
  };
  return (await col.deliveries(db).insertOne(d)).insertedId;
}

// a rider with no photo must give a note, and the stop is flagged
const r1 = await row();
let threw = false;
try {
  await markDelivered(r1, { lat: 17.47, lng: 78.54 }, riderCtx);
} catch {
  threw = true;
}
t('rider without photo or note is refused', threw);
t('refused mark leaves no stray note', (await col.deliveries(db).findOne({ _id: r1 }))?.note === undefined);
const d1 = await markDelivered(r1, { lat: 17.47, lng: 78.54 }, riderCtx, { note: 'Camera broken, handed to the watchman' });
t('rider with a note is accepted', d1.status === 'delivered' && d1.note === 'Camera broken, handed to the watchman');
t('rider without photo is flagged', d1.proof?.flagged === true);

// a staff desk correction is not flagged
const r2 = await row();
const d2 = await markDelivered(r2, { capturedAt: now }, staffCtx, { note: 'Customer confirmed on the phone' });
t('staff desk correction accepted', d2.status === 'delivered');
t('staff desk correction not flagged', d2.proof?.flagged !== true);

// clearing a flag
let riderCleared = false;
try {
  await clearProofFlag(r1, 'looks fine', riderCtx);
  riderCleared = true;
} catch {
  /* expected */
}
t('a rider cannot clear a flag', !riderCleared);
const c1 = await clearProofFlag(r1, 'Called the customer, milk received', staffCtx);
t('staff clears the flag', c1.proof?.flagged === false && c1.proof?.flagClearedBy === '9830000011');
t('delivery stays delivered', c1.status === 'delivered');
t('flag_cleared event recorded', (await col.events(db).countDocuments({ entityId: String(r1), type: 'delivery.flag_cleared' })) === 1);
await clearProofFlag(r1, 'again', staffCtx);
t('clearing twice is a no-op', (await col.events(db).countDocuments({ entityId: String(r1), type: 'delivery.flag_cleared' })) === 1);

await col.deliveries(db).deleteMany({ _id: { $in: [r1, r2] } });
console.log(`orch-outcomes: ${passed} passed, ${failed} failed · db=${db.databaseName}`);
process.exit(failed ? 1 : 0);
