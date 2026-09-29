// Integration test for B6 notifications — real Mongo, isolated DB. Run:
//   MONGODB_DB=maavuli_it_b6 pnpm db:init
//   MONGODB_DB=maavuli_it_b6 pnpm it scripts/it/b6-notify.ts
//
// Covers: dedupe, suppressed-without-opt-in, drain via the log provider, the status
// webhook advancing (and not regressing) a message, inbound idempotency, and opt-out.
import { getDb } from '@/lib/db';
import { col } from '@/lib/models';
import { enqueueMessage, drainOutbox, applyStatusReceipt } from '@/lib/notify';
import { setWhatsappOptIn } from '@/lib/notify/optin';
import { systemCtx } from '@/lib/clock';

// Force the log provider regardless of ambient env.
process.env.WHATSAPP_PROVIDER = 'log';

let passed = 0;
let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
}

const OPTED = '9600000001';
const NOOPT = '9600000002';
const now = new Date('2026-10-01T04:00:00.000Z');
const ctx = systemCtx(now, 'it-b6');

async function main(): Promise<void> {
  const db = await getDb();

  // clean slate for our test mobiles
  await col.users(db).deleteMany({ mobile: { $in: [OPTED, NOOPT] } });
  await col.outbox(db).deleteMany({ mobile: { $in: [OPTED, NOOPT] } });
  await col.inbound(db).deleteMany({ from: { $in: [OPTED, NOOPT] } });

  await col.users(db).insertOne({ mobile: OPTED, whatsappOptIn: true, whatsappOptInAt: now, lang: 'en', createdAt: now });
  await col.users(db).insertOne({ mobile: NOOPT, whatsappOptIn: false, lang: 'te', createdAt: now });

  // 1. opted-in customer → queued
  await enqueueMessage(
    { mobile: OPTED, template: 'delivered_today', params: { time: '6:45 AM' }, dedupeKey: 'it:d1' },
    ctx,
  );
  const q1 = await col.outbox(db).findOne({ dedupeKey: 'it:d1' });
  eq('opted-in → queued', q1?.status, 'queued');
  eq('lang from user', q1?.status === 'queued' ? q1?.lang : undefined, 'en');

  // 2. dedupe — same key does not insert a second row
  await enqueueMessage(
    { mobile: OPTED, template: 'delivered_today', params: { time: '9:00 AM' }, dedupeKey: 'it:d1' },
    ctx,
  );
  eq('dedupe keeps one row', await col.outbox(db).countDocuments({ dedupeKey: 'it:d1' }), 1);

  // 3. no opt-in → suppressed
  await enqueueMessage(
    { mobile: NOOPT, template: 'delivered_today', params: { time: '7:00 AM' }, dedupeKey: 'it:d2' },
    ctx,
  );
  const s2 = await col.outbox(db).findOne({ dedupeKey: 'it:d2' });
  eq('no opt-in → suppressed', s2?.status, 'suppressed');
  eq('suppressed uses user lang te', s2?.lang, 'te');

  // 4. drain via log → 'logged', providerMessageId set, suppressed untouched
  const drained = await drainOutbox(ctx);
  eq('drain logged one', drained.logged, 1);
  eq('drain sent zero (log provider)', drained.sent, 0);
  const afterDrain = await col.outbox(db).findOne({ dedupeKey: 'it:d1' });
  eq('drained → logged', afterDrain?.status, 'logged');
  eq('provider recorded', afterDrain?.provider, 'log');
  eq('providerMessageId set', typeof afterDrain?.providerMessageId, 'string');
  const supStill = await col.outbox(db).findOne({ dedupeKey: 'it:d2' });
  eq('suppressed stays suppressed after drain', supStill?.status, 'suppressed');

  // 5. status webhook advances a SENT message (simulate a real send row)
  await col.outbox(db).insertOne({
    mobile: OPTED,
    template: 'order_confirmed',
    lang: 'en',
    params: {},
    dedupeKey: 'it:sent1',
    status: 'sent',
    provider: 'meta',
    providerMessageId: 'wamid.IT1',
    attempts: 1,
    createdAt: now,
    updatedAt: now,
  });
  await applyStatusReceipt('wamid.IT1', 'delivered', now, db);
  eq('sent → delivered', (await col.outbox(db).findOne({ providerMessageId: 'wamid.IT1' }))?.status, 'delivered');
  await applyStatusReceipt('wamid.IT1', 'read', now, db);
  eq('delivered → read', (await col.outbox(db).findOne({ providerMessageId: 'wamid.IT1' }))?.status, 'read');
  // regression guard: a late 'delivered' must NOT undo 'read'
  await applyStatusReceipt('wamid.IT1', 'delivered', now, db);
  eq('read is not moved backwards', (await col.outbox(db).findOne({ providerMessageId: 'wamid.IT1' }))?.status, 'read');
  // unknown id → false, no throw
  eq('unknown providerMessageId → false', await applyStatusReceipt('wamid.NONE', 'read', now, db), false);

  // 6. inbound idempotent
  await col.inbound(db).insertOne({
    providerMessageId: 'wamid.IN1',
    from: OPTED,
    type: 'text',
    text: 'hello',
    receivedAt: now,
    handled: false,
  });
  let dupCode = 0;
  try {
    await col.inbound(db).insertOne({
      providerMessageId: 'wamid.IN1',
      from: OPTED,
      type: 'text',
      receivedAt: now,
      handled: false,
    });
  } catch (e) {
    dupCode = (e as { code?: number }).code ?? 0;
  }
  eq('inbound duplicate rejected by unique index', dupCode, 11000);

  // 7. opt-out flips the flag and a subsequent enqueue is suppressed
  await setWhatsappOptIn(OPTED, false, 'whatsapp_stop', ctx);
  eq('opt-out clears flag', (await col.users(db).findOne({ mobile: OPTED }))?.whatsappOptIn, false);
  await enqueueMessage(
    { mobile: OPTED, template: 'delivered_today', params: { time: '8:00 AM' }, dedupeKey: 'it:d3' },
    ctx,
  );
  eq('after opt-out → suppressed', (await col.outbox(db).findOne({ dedupeKey: 'it:d3' }))?.status, 'suppressed');

  // cleanup
  await col.users(db).deleteMany({ mobile: { $in: [OPTED, NOOPT] } });
  await col.outbox(db).deleteMany({ mobile: { $in: [OPTED, NOOPT] } });
  await col.inbound(db).deleteMany({ from: { $in: [OPTED, NOOPT] } });

  console.log(`b6-notify: ${passed} passed, ${failed} failed · db=${db.databaseName}`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
