// Integration test: FX2 fixes (day engine + security) from RV-STATE / RV-SEC.
//   MONGODB_DB=maavuli_it_fx2 pnpm -s db:init
//   MONGODB_DB=maavuli_it_fx2 pnpm -s run it scripts/it/fx2.ts
//
// Business time is 2031-03-10 10:30 IST (before the 16:00 cutoff) unless a case says
// otherwise; fresh mobiles per run, so cases do not depend on each other.
import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ObjectId } from 'mongodb';
import type { Subscription } from '@/lib/models';
import type { OpCtx } from '@/lib/clock';
import type { CheckoutInput } from '@/lib/orders';

// Next's server runtime installs this global, and next/headers' request stores are
// created from it at module load; a plain tsx process has none. Install it BEFORE any
// app module loads (hence the dynamic imports below), so the goodwill case can run
// the real route inside a request scope.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

const { getDb } = await import('@/lib/db');
const { col } = await import('@/lib/models');
const { customerActor } = await import('@/lib/clock');
const { circleToPolygon } = await import('@/lib/geo');
const { __setRazorpayCreateOrderForTests, createCheckoutOrder, markOrderPaid } = await import('@/lib/orders');
const { pauseDates, unpauseDates } = await import('@/lib/pause');
const { closeDay, lockDay } = await import('@/lib/manifest');
const { createDisruption } = await import('@/lib/disruptions');
const { isDateLocked } = await import('@/lib/daylock');
const { withLease } = await import('@/lib/jobs');
const { createTicket, resolveTicket } = await import('@/lib/tickets');
const { resolveProvider } = await import('@/lib/notify/providers');
const { ServiceNotConfiguredError, ValidationError } = await import('@/lib/errors');
const { GOODWILL_CAP_PAISE } = await import('@/lib/credits');

const db = await getDb();
if (!db.databaseName.startsWith('maavuli_it_')) {
  console.error(`refusing to run against ${db.databaseName} — set MONGODB_DB=maavuli_it_fx2`);
  process.exit(2);
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
async function caseRun(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} — threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---- fixtures ---------------------------------------------------------------
const CENTRE_A = { lat: 17.385, lng: 78.4867 };
const PIN_A = { lat: 17.386, lng: 78.487 };
const CENTRE_B = { lat: 17.48, lng: 78.56 };
const PIN_B = { lat: 17.481, lng: 78.561 };
async function zone(name: string, centre: { lat: number; lng: number }): Promise<ObjectId> {
  const z = await col.zones(db).findOne({ name });
  if (z?._id) return z._id;
  const r = await col.zones(db).insertOne({
    name,
    active: true,
    shape: { kind: 'circle', centre, radiusM: 2000 },
    geometry: circleToPolygon(centre, 2000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return r.insertedId;
}
const ZONE_A = await zone('fx2-zone-a', CENTRE_A);
const ZONE_B = await zone('fx2-zone-b', CENTRE_B);

// Business dates are fixed, so a previous run's day locks would close them: this is
// an isolated maavuli_it_* database, reset those locks so every run starts open.
await col.dayLocks(db).deleteMany({ _id: { $in: ['2031-03-14', '2031-03-15', '2031-03-16', '2031-03-17', '2031-03-18'] } });

const freshMobile = () => `94${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const NOW = new Date('2031-03-10T05:00:00Z'); // 10:30 IST
const at = (mobile: string, now = NOW): OpCtx => ({ now, actor: customerActor(mobile) });
const staffCtx = (now = NOW): OpCtx => ({ now, actor: { kind: 'staff', id: 'fx2-it' } });

__setRazorpayCreateOrderForTests(async ({ amountPaise, receipt }) => ({
  id: `order_fake_${new ObjectId().toHexString()}`,
  entity: 'order',
  amount: amountPaise,
  currency: 'INR',
  receipt,
  status: 'created',
}));

type Sub = Subscription & { _id: ObjectId };
async function buy(mobile: string, pin = PIN_A, over: Partial<CheckoutInput> = {}): Promise<Sub> {
  const input: CheckoutInput = {
    mobile,
    purpose: 'new',
    kind: 'cow',
    quantityId: 'one',
    tenureId: '1m',
    details: { name: 'FX2 Customer', address: 'Flat 1, Test Street, Test Area', location: pin },
    useCredit: false,
    whatsappOptIn: true,
    idempotencyKey: `fx2-${new ObjectId().toHexString()}`,
    ...over,
  };
  const res = await createCheckoutOrder(input, at(mobile));
  await markOrderPaid(res.order._id, { razorpayPaymentId: `pay_fake_${new ObjectId().toHexString()}`, source: 'verify' }, at(mobile));
  const s = await col.subscriptions(db).findOne({ orderId: res.order._id });
  if (!s?._id) throw new Error('no subscription for order');
  return s as Sub;
}
const reload = async (id: ObjectId) => (await col.subscriptions(db).findOne({ _id: id })) as Sub;
const planRows = (subscriptionId: ObjectId) =>
  col.deliveries(db).countDocuments({ subscriptionId, source: { $in: ['plan', 'makeup'] } });
const rowOn = (subscriptionId: ObjectId, date: string) => col.deliveries(db).findOne({ subscriptionId, date, source: 'plan' });

// ---- P1-2 · pause / unpause double-submit ---------------------------------------
await caseRun('P1-2 double pause', async () => {
  const m = freshMobile();
  const sub = await buy(m);
  const date = sub.startDate > '2031-03-14' ? sub.startDate : '2031-03-14';
  const rowsBefore = await planRows(sub._id);
  // four taps at once (a double-submit on a slow connection, plus retries)
  const r = await Promise.allSettled([1, 2, 3, 4].map(() => pauseDates(sub._id, [date], at(m))));
  t('P1-2 pause: every request answered without error', r.every(x => x.status === 'fulfilled'), r.map(x => x.status === 'rejected' ? String(x.reason) : 'ok'));
  const after = await reload(sub._id);
  t('P1-2 pause: allowance spent once', after.pauseUsedDays === 1 && after.daysPaused === 1, { used: after.pauseUsedDays, daysPaused: after.daysPaused });
  t('P1-2 pause: plan extended by exactly one day', after.endDate === addDay(sub.endDate, 1), { before: sub.endDate, after: after.endDate });
  t('P1-2 pause: row count unchanged (one removed, one appended)', (await planRows(sub._id)) === rowsBefore);
  t('P1-2 pause: one pause record', (await col.pausedDates(db).countDocuments({ subscriptionId: sub._id })) === 1);

  const u = await Promise.allSettled([1, 2, 3, 4].map(() => unpauseDates(sub._id, [date], at(m))));
  t('P1-2 unpause: every request answered without error', u.every(x => x.status === 'fulfilled'), u.map(x => x.status === 'rejected' ? String(x.reason) : 'ok'));
  const back = await reload(sub._id);
  t('P1-2 unpause: allowance returned once (never negative)', back.pauseUsedDays === 0 && back.daysPaused === 0, { used: back.pauseUsedDays, daysPaused: back.daysPaused });
  t('P1-2 unpause: endDate back to the original (one tail day removed)', back.endDate === sub.endDate, { orig: sub.endDate, now: back.endDate });
  t('P1-2 unpause: row count back to the original', (await planRows(sub._id)) === rowsBefore);
  t('P1-2 unpause: restored date planned again', (await rowOn(sub._id, date))?.status === 'planned');
});

// ---- P2-1 · pause racing the lock of the same date ------------------------------
await caseRun('P2-1 pause vs lock', async () => {
  const m = freshMobile();
  const sub = await buy(m);
  const rowsBefore = await planRows(sub._id);
  const trialDates = ['2031-03-16', '2031-03-17', '2031-03-18'];
  for (const date of trialDates) {
    await Promise.allSettled([pauseDates(sub._id, [date], at(m)), lockDay(date, staffCtx())]);
  }
  const s = await reload(sub._id);
  const pausedDocs = await col.pausedDates(db).find({ subscriptionId: sub._id }).toArray();
  let consistent = true;
  for (const date of trialDates) {
    const row = await rowOn(sub._id, date);
    const paused = pausedDocs.some(p => p.date === date);
    // exactly one of: paused (no row) or delivered (locked row, no pause record)
    if (paused === Boolean(row)) consistent = false;
  }
  t('P2-1 each date is either paused or locked, never both', consistent);
  t('P2-1 allowance equals the pause records', s.pauseUsedDays === pausedDocs.length, { used: s.pauseUsedDays, records: pausedDocs.length });
  t('P2-1 no free day: rows = original total', (await planRows(sub._id)) === rowsBefore, { before: rowsBefore, after: await planRows(sub._id) });
});

// ---- P1-5 · a disruption on an open future date freezes only its zone -----------
await caseRun('P1-5 future disruption', async () => {
  const ma = freshMobile();
  const mb = freshMobile();
  const subA = await buy(ma, PIN_A);
  const subB = await buy(mb, PIN_B);
  const date = '2031-03-15'; // open: cutoff is 16:00 on 03-14
  t('P1-5 fixture: both customers have a planned row', (await rowOn(subA._id, date))?.status === 'planned' && (await rowOn(subB._id, date))?.status === 'planned');
  const res = await createDisruption({ date, zoneIds: [ZONE_A], reason: 'Road work in zone A' }, staffCtx());
  t('P1-5 zone A row marked not delivered', (await rowOn(subA._id, date))?.status === 'not_delivered', await rowOn(subA._id, date));
  t('P1-5 disruption counted the zone A customer', res.affected >= 1 && res.failed === 0, res);
  t('P1-5 zone B row untouched (still planned)', (await rowOn(subB._id, date))?.status === 'planned', (await rowOn(subB._id, date))?.status);
  t('P1-5 no day lock was created', (await col.dayLocks(db).countDocuments({ _id: date })) === 0);
  t('P1-5 the date is still open for everyone else', !(await isDateLocked(date, at(mb))));
  const p = await pauseDates(subB._id, [date], at(mb));
  t('P1-5 zone B customer can still pause that date', p.success && (await rowOn(subB._id, date)) === null);
  let refused = false;
  try {
    await pauseDates(subA._id, [date], at(ma));
  } catch (e) {
    refused = e instanceof ValidationError;
  }
  t('P1-5 zone A customer cannot pause the disrupted date', refused);
  const ev = await col.events(db).countDocuments({ entityId: (await rowOn(subA._id, date))!._id!.toHexString(), type: 'delivery.locked' });
  t('P1-5 the early freeze is on the row timeline', ev === 1);

  // past its cutoff: keeps the whole-day lock (zone B's first day, disrupted at
  // 17:00 IST the evening before — after the 16:00 cutoff)
  const lateDate = subB.startDate;
  const late = new Date(`${addDay(lateDate, -1)}T11:30:00Z`);
  t('P1-5 fixture: zone B has a planned row on its first day', (await rowOn(subB._id, lateDate))?.status === 'planned');
  await createDisruption({ date: lateDate, zoneIds: [ZONE_B], reason: 'Van broke down' }, staffCtx(late));
  t('P1-5 past-cutoff date is locked as a whole', (await col.dayLocks(db).countDocuments({ _id: lateDate })) === 1);
  t('P1-5 past-cutoff: zone A row of that date locked too (whole day)', (await rowOn(subA._id, lateDate))?.status === 'locked', (await rowOn(subA._id, lateDate))?.status);
  t('P1-5 past-cutoff: zone B row marked not delivered', (await rowOn(subB._id, lateDate))?.status === 'not_delivered');
});

// ---- P2-14 · a lease released by a step that overran it -------------------------
await caseRun('P2-14 lease token', async () => {
  const name = `fx2-step-${new ObjectId().toHexString()}`;
  let third: { value: number } | null | 'unset' = 'unset';
  const p1 = withLease(name, 50, async () => {
    await sleep(200); // overruns its 50 ms lease
    return 1;
  });
  await sleep(100);
  const p2 = withLease(name, 10_000, async () => {
    await sleep(250); // p1 has finished (and released) by now
    third = await withLease(name, 10_000, async () => 3);
    return 2;
  });
  const [r1, r2] = await Promise.all([p1, p2]);
  t('P2-14 first and second holders both ran', r1?.value === 1 && r2?.value === 2);
  t('P2-14 overrunning step did not free the second holder’s lease', third === null, third);
  const doc = await col.jobRuns(db).findOne({ _id: name });
  t('P2-14 lease released by its own holder at the end', !doc?.leaseUntil, doc);
});

// ---- P2-15 · closeDay moves rows one by one, with events -------------------------
await caseRun('P2-15 closeDay events', async () => {
  const m = freshMobile();
  const sub = await buy(m);
  const date = '2031-03-20';
  await lockDay(date, staffCtx());
  const row = await rowOn(sub._id, date);
  t('P2-15 fixture: row locked', row?.status === 'locked');
  const closeAt = new Date('2031-03-20T06:30:00Z'); // 12:00 IST
  const r = await closeDay(date, staffCtx(closeAt));
  t('P2-15 row unconfirmed', (await rowOn(sub._id, date))?.status === 'unconfirmed');
  t('P2-15 count reported', r.unconfirmed >= 1, r);
  const ev = await col.events(db).findOne({ entityId: row!._id!.toHexString(), type: 'delivery.unconfirmed' });
  t('P2-15 delivery.unconfirmed event on the customer timeline', ev?.mobile === m && ev?.from === 'locked' && ev?.to === 'unconfirmed', ev);
  const again = await closeDay(date, staffCtx(closeAt));
  t('P2-15 re-close is a no-op', again.unconfirmed === 0);
});

// ---- SEC-8 · ticket resolution cap ------------------------------------------------
await caseRun('SEC-8 ticket resolution cap', async () => {
  const m = freshMobile();
  const tk = await createTicket({ mobile: m, kind: 'other', channel: 'web', note: 'x' }, at(m));
  let refused = false;
  try {
    await resolveTicket(tk._id!, 'y'.repeat(501), staffCtx());
  } catch (e) {
    refused = e instanceof ValidationError;
  }
  t('SEC-8 a 501-char resolution is refused', refused);
  t('SEC-8 the ticket is still open', (await col.tickets(db).findOne({ _id: tk._id }))?.status === 'open');
  const ok = await resolveTicket(tk._id!, 'z'.repeat(500), staffCtx());
  t('SEC-8 a 500-char resolution is accepted', ok.status === 'resolved');
});

// ---- SEC-8 · WHATSAPP_PROVIDER=log refused in production -------------------------
await caseRun('SEC-8 log provider in production', async () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { NODE_ENV: env.NODE_ENV, WHATSAPP_PROVIDER: env.WHATSAPP_PROVIDER };
  try {
    env.WHATSAPP_PROVIDER = 'log';
    env.NODE_ENV = 'production';
    let refused = false;
    try {
      resolveProvider();
    } catch (e) {
      refused = e instanceof ServiceNotConfiguredError;
    }
    t('SEC-8 log provider refused in production', refused);
    env.NODE_ENV = 'development';
    t('SEC-8 log provider still allowed outside production', resolveProvider().name === 'log');

    // production log line: no body, no media URL, masked mobile
    const { logProvider } = await import('@/lib/notify/providers');
    env.NODE_ENV = 'production';
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    try {
      await logProvider.send({
        mobile: '9876543210',
        template: 'ticket_update',
        lang: 'en',
        params: { status: 'Resolved', note: 'SECRET-BODY-TEXT' },
        mediaUrl: 'https://example.test/signed/abc?sig=SECRET',
      } as Parameters<typeof logProvider.send>[0]);
    } finally {
      console.log = orig;
    }
    const line = lines.join('\n');
    t('SEC-8 production log line has no body, media URL or full mobile', line.includes('[notify:log]') && !line.includes('SECRET') && !line.includes('9876543210'), line);
  } finally {
    env.NODE_ENV = saved.NODE_ENV;
    if (saved.WHATSAPP_PROVIDER === undefined) delete env.WHATSAPP_PROVIDER;
    else env.WHATSAPP_PROVIDER = saved.WHATSAPP_PROVIDER;
  }
});

// ---- SEC-8 · verify_token handshake (timing-safe compare still matches) ----------
await caseRun('SEC-8 whatsapp verify_token', async () => {
  process.env.WHATSAPP_VERIFY_TOKEN = 'fx2-verify-token';
  const { GET } = await import('@/app/api/webhooks/whatsapp/route');
  const good = await GET(new Request('http://x/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=fx2-verify-token&hub.challenge=42'));
  t('SEC-8 correct token echoes the challenge', good.status === 200 && (await good.text()) === '42');
  const bad = await GET(new Request('http://x/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=fx2-verify-tokeX&hub.challenge=42'));
  t('SEC-8 wrong token is 403', bad.status === 403);
  const short = await GET(new Request('http://x/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=f&hub.challenge=42'));
  t('SEC-8 different-length token is 403 (no throw)', short.status === 403);
});

// ---- SEC-8 · goodwill aggregate cap, through the real route ----------------------
// The route reads the staff session from cookies(); run it inside a minimal Next
// request scope carrying a real session cookie.
await caseRun('SEC-8 goodwill aggregate', async () => {
  const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external.js');
  const { workUnitAsyncStorage } = await import('next/dist/server/app-render/work-unit-async-storage.external.js');
  const { RequestCookies } = await import('next/dist/compiled/@edge-runtime/cookies/index.js');
  const { SESSION_COOKIE } = await import('@/lib/auth');
  const { POST } = await import('@/app/api/admin/credits/route');

  async function staffSession(role: 'support' | 'ops'): Promise<string> {
    const mobile = freshMobile();
    await col.staff(db).insertOne({ mobile, name: `fx2 ${role}`, role, active: true, createdAt: new Date(), updatedAt: new Date() });
    const raw = randomBytes(32).toString('hex');
    await col.sessions(db).insertOne({
      token: createHash('sha256').update(raw).digest('hex'),
      mobile,
      isAdmin: false,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return raw;
  }
  async function grant(sessionRaw: string, mobile: string, amountPaise: number): Promise<number> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE}=${sessionRaw}`, 'content-type': 'application/json' });
    const req = new Request('http://x/api/admin/credits', {
      method: 'POST',
      headers,
      body: JSON.stringify({ mobile, amountPaise, note: 'fx2 goodwill test' }),
    });
    const workStore = { route: '/api/admin/credits', forceStatic: false, dynamicShouldError: false, isStaticGeneration: false } as never;
    const unit = { type: 'request', phase: 'render', cookies: new RequestCookies(headers) } as never;
    const res = await workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(unit, () => POST(req)));
    return res.status;
  }

  const customer = freshMobile();
  await buy(customer); // provisions the user row
  const s1 = await staffSession('support');
  const s2 = await staffSession('support');
  const cap = GOODWILL_CAP_PAISE.support;
  const half = Math.floor(cap / 2);

  t('SEC-8 first grant within the cap', (await grant(s1, customer, half)) === 201);
  // two concurrent grants by two support staff that together pass the cap: one wins
  const [a, b] = await Promise.all([grant(s1, customer, half), grant(s2, customer, half)]);
  t('SEC-8 concurrent grants: exactly one passes the aggregate', [a, b].sort().join(',') === '201,403', { a, b });
  t('SEC-8 a further grant by another staff member is refused', (await grant(s2, customer, 1)) === 403);
  const total = (await col.credits(db).find({ mobile: customer, kind: 'goodwill' }).toArray()).reduce((s, r) => s + r.amountPaise, 0);
  t('SEC-8 24 h goodwill total never exceeds the support cap', total <= cap, { total, cap });
  const ops = await staffSession('ops');
  t('SEC-8 a higher role (ops) can still add within its own cap', (await grant(ops, customer, half)) === 201);
});

function addDay(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

console.log(`fx2: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
