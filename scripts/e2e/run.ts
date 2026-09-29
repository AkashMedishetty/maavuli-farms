// End-to-end suite: ONE `next dev` on 127.0.0.1:3310 against the isolated
// `maavuli_e2e` database, driven purely over HTTP (business time via x-maavuli-now).
//
//   MONGODB_DB=maavuli_e2e pnpm run e2e            all flows
//   MONGODB_DB=maavuli_e2e pnpm run e2e -- 1,2,3    only these flows (setup always runs)
//
// OWNER: B10. The dev server child is ALWAYS killed (exit, failure, SIGINT, SIGTERM).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DB_NAME = 'maavuli_e2e';
const PORT = 3310;
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = '9800000099';
const OPS = '9800000011';
const SUPPORT = '9800000012';
const RIDER = '9800000001';
const CUST = { A: '9810000001', B: '9810000002', C: '9810000003', D: '9810000004' } as const;
const PIN = {
  A: { lat: 17.4745, lng: 78.5478 }, // DEV Safilguda (rider 1)
  A2: { lat: 17.4749, lng: 78.5481 }, // A's new doorstep, still Safilguda
  B: { lat: 17.474, lng: 78.546 }, // Safilguda
  C: { lat: 17.4725, lng: 78.5455 }, // Safilguda
  D: { lat: 17.4512, lng: 78.5362 }, // DEV Malkajgiri (rider 2)
  OUT: { lat: 17.6, lng: 78.7 }, // nowhere
};
const ERROR_MARKERS = ['Application error', 'Unhandled Runtime Error', 'Internal Server Error'];
const REQ_TIMEOUT_MS = 180_000;

/** IST wall-clock → ISO instant. */
const ist = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+05:30`).toISOString();
const D1 = '2031-03-10'; // sign-up day
const D2 = '2031-03-11'; // first delivery
const D3 = '2031-03-12';
const D4 = '2031-03-13';
const D5 = '2031-03-14';

/* ------------------------------------------------------------------ guard -- */

if ((process.env.MONGODB_DB ?? '').trim() !== DB_NAME) {
  console.log(`e2e: refusing to run — set MONGODB_DB=${DB_NAME} (got "${process.env.MONGODB_DB ?? ''}")`);
  process.exit(2);
}
const MONGODB_URI = (process.env.MONGODB_URI ?? '').trim();
if (!MONGODB_URI) {
  console.log('e2e: MONGODB_URI is not set (.env.local)');
  process.exit(2);
}
const only = (process.argv[2] ?? '').split(',').map(s => s.trim()).filter(Boolean);
const want = (n: number) => only.length === 0 || only.includes(String(n));

/* --------------------------------------------------------------- results -- */

interface Step { flow: string; name: string; ok: boolean | null; detail?: string }
const steps: Step[] = [];
let flow = 'setup';
function pass(name: string, detail?: string) {
  steps.push({ flow, name, ok: true, ...(detail ? { detail } : {}) });
  console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`);
}
function fail(name: string, detail: string) {
  steps.push({ flow, name, ok: false, detail });
  console.log(`  FAIL  ${name}  — ${detail}`);
}
function notVerified(name: string, detail: string) {
  steps.push({ flow, name, ok: null, detail });
  console.log(`  N/V   ${name}  — ${detail}`);
}
function check(name: string, cond: boolean, detailIfFail: string, detailIfPass?: string) {
  if (cond) pass(name, detailIfPass);
  else fail(name, detailIfFail);
  return cond;
}
function header(title: string) {
  flow = title;
  console.log(`\n== ${title}`);
}

/* ----------------------------------------------------------- dev server -- */

let child: ChildProcess | null = null;
let childLog = '';
const otpCodes = new Map<string, string>();
const logPath = path.join(tmpdir(), `maavuli-e2e-next-${process.pid}.log`);
const logFile = createWriteStream(logPath);

function killChild() {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
  }
  const pid = child.pid;
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
}
process.on('exit', killChild);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    console.log(`\ne2e: ${sig} — stopping the dev server`);
    killChild();
    process.exit(130);
  });
}
process.on('uncaughtException', err => {
  console.log('e2e: uncaught', err);
  killChild();
  process.exit(1);
});
process.on('unhandledRejection', err => {
  console.log('e2e: unhandled rejection', err);
  killChild();
  process.exit(1);
});

const CRON_SECRET = randomBytes(24).toString('hex');

function onChildOutput(buf: Buffer) {
  const s = buf.toString();
  logFile.write(s);
  childLog = (childLog + s).slice(-200_000);
  for (const m of s.matchAll(/\[otp\] (\d{10}): (\d{6})/g)) otpCodes.set(m[1]!, m[2]!);
}

async function startServer() {
  // next dev sets NODE_ENV itself; an inherited production value would disable time travel
  const { NODE_ENV: _ignored, ...inherited } = process.env;
  const env: Record<string, string | undefined> = {
    ...inherited,
    MONGODB_DB: DB_NAME,
    MAAVULI_TIME_TRAVEL: '1',
    STORAGE_DRIVER: 'local',
    WHATSAPP_PROVIDER: 'log',
    ADMIN_MOBILES: OWNER,
    CRON_SECRET,
    NEXT_TELEMETRY_DISABLED: '1',
  };
  const bin = path.join(ROOT, 'node_modules', '.bin', 'next');
  const proc = spawn(bin, ['dev', '-H', '127.0.0.1', '-p', String(PORT)], {
    cwd: ROOT,
    env: env as NodeJS.ProcessEnv, // NODE_ENV intentionally absent: next dev sets it
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  proc.stdout?.on('data', onChildOutput);
  proc.stderr?.on('data', onChildOutput);
  proc.on('exit', code => { logFile.write(`\n[e2e] next dev exited ${code}\n`); });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`next dev exited early (${proc.exitCode}); log: ${logPath}`);
    try {
      const r = await fetch(`${BASE}/api/auth/me`, { signal: AbortSignal.timeout(120_000) });
      if (r.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`next dev not ready in 180 s; log: ${logPath}`);
}

/* ----------------------------------------------------------------- http -- */

class Actor {
  jar = new Map<string, string>();
  constructor(public label: string, public mobile: string | null) {}
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      if (i > 0) this.jar.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  }
}

interface Res { status: number; json: Record<string, unknown> | null; text: string; headers: Headers; bytes?: Buffer }

async function call(
  who: Actor | null,
  method: string,
  url: string,
  opts: { body?: unknown; raw?: Buffer; contentType?: string; now?: string; headers?: Record<string, string>; binary?: boolean } = {},
): Promise<Res> {
  const h: Record<string, string> = { ...(opts.headers ?? {}) };
  if (who && who.jar.size) h.cookie = who.cookie();
  if (opts.now) h['x-maavuli-now'] = opts.now;
  let body: BodyInit | undefined;
  if (opts.raw) {
    body = new Uint8Array(opts.raw);
    h['content-type'] = opts.contentType ?? 'application/octet-stream';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    h['content-type'] = 'application/json';
  }
  const res = await fetch(BASE + url, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  who?.absorb(res);
  if (opts.binary) {
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, json: null, text: '', headers: res.headers, bytes };
  }
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

const snip = (r: Res) => `${r.status} ${(r.text || '').replace(/\s+/g, ' ').slice(0, 220)}`;
function expectStatus(name: string, r: Res, want: number | number[]) {
  const ok = Array.isArray(want) ? want.includes(r.status) : r.status === want;
  return check(name, ok, `want ${JSON.stringify(want)}, got ${snip(r)}`, String(r.status));
}

async function signIn(a: Actor) {
  const mobile = a.mobile!;
  otpCodes.delete(mobile);
  const r = await call(a, 'POST', '/api/auth/request', { body: { mobile } });
  if (r.status !== 200) throw new Error(`sign-in request ${a.label}: ${snip(r)}`);
  let code = typeof r.json?.devCode === 'string' ? (r.json.devCode as string) : undefined;
  for (let i = 0; !code && i < 50; i++) {
    code = otpCodes.get(mobile);
    if (!code) await new Promise(res => setTimeout(res, 100));
  }
  if (!code) throw new Error(`sign-in ${a.label}: no devCode and no [otp] log line`);
  const v = await call(a, 'POST', '/api/auth/verify', { body: { mobile, code } });
  if (v.status !== 200) throw new Error(`sign-in verify ${a.label}: ${snip(v)}`);
}

/* ------------------------------------------------------------------- db -- */

let mongo: MongoClient | undefined;
let db: Db;

function runScript(rel: string) {
  const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const r = spawnSync(tsx, ['--env-file-if-exists=.env.local', rel], {
    cwd: ROOT,
    env: { ...process.env, MONGODB_DB: DB_NAME },
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0) throw new Error(`${rel} failed (${r.status}): ${out.slice(-600)}`);
  return out.split('\n').slice(-1)[0] ?? '';
}

async function resetDb() {
  mongo = new MongoClient(MONGODB_URI);
  await mongo.connect();
  db = mongo.db(DB_NAME);
  if (db.databaseName !== DB_NAME) throw new Error('wrong database');
  const cols = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const c of cols) if (!c.name.startsWith('system.')) await db.collection(c.name).deleteMany({});
  pass('emptied collections', `${cols.length} collections in ${DB_NAME}`);
  pass('init indexes', runScript('scripts/init-db.ts'));
  pass('seed-dev', runScript('scripts/seed-dev.ts').slice(0, 120));
}

/* ------------------------------------------------------------ fixtures -- */

const anon = new Actor('anon', null);
const owner = new Actor('owner', OWNER);
const ops = new Actor('ops', OPS);
const support = new Actor('support', SUPPORT);
const rider = new Actor('rider', RIDER);
const A = new Actor('A', CUST.A);
const B = new Actor('B', CUST.B);
const C = new Actor('C', CUST.C);
const Dd = new Actor('D', CUST.D);

const state: {
  subA?: string; subC?: string; subD?: string; subB?: string;
  delA?: string; delC?: string; photoKey?: string; malkajgiriId?: string;
} = {};

function details(name: string, pin: { lat: number; lng: number }, house: string) {
  return { name, address: `${house}, e2e street, Safilguda`, location: pin, addressParts: { house, area: 'Safilguda' } };
}

async function subOf(mobile: string) {
  return db.collection('subscriptions').findOne({ mobile }, { sort: { createdAt: -1 } });
}

/* ================================================================ flows == */

async function flowAccess() {
  header('1. access');
  expectStatus('anon /api/rider/today → 401', await call(anon, 'GET', '/api/rider/today'), 401);
  expectStatus('anon /api/admin/manifest → 401', await call(anon, 'GET', '/api/admin/manifest'), [401, 403]);
  expectStatus('anon /api/admin/messages → 401', await call(anon, 'GET', '/api/admin/messages'), [401, 403]);
  expectStatus('anon PUT /api/admin/settings → 401', await call(anon, 'PUT', '/api/admin/settings', { body: { cutoffTime: '17:00' } }), [401, 403]);
  expectStatus('customer A /api/admin/manifest → 403', await call(A, 'GET', '/api/admin/manifest'), 403);
  expectStatus('customer A POST /api/admin/credits → 403', await call(A, 'POST', '/api/admin/credits', { body: { mobile: CUST.A, amountPaise: 100, note: 'self-serve' } }), 403);
  expectStatus('customer A /api/rider/today → 403', await call(A, 'GET', '/api/rider/today'), 403);
  expectStatus('rider /api/admin/manifest → 403', await call(rider, 'GET', '/api/admin/manifest'), 403);
  expectStatus('rider POST /api/admin/disruptions → 403', await call(rider, 'POST', '/api/admin/disruptions', { body: { date: D4, reason: 'rider try' } }), 403);
  expectStatus('support POST /api/admin/disruptions → 403', await call(support, 'POST', '/api/admin/disruptions', { body: { date: D4, reason: 'support try' }, now: ist(D1, '11:00') }), 403);
  expectStatus('support POST /api/admin/days/<d>/lock → 403', await call(support, 'POST', `/api/admin/days/${D2}/lock`, { body: {}, now: ist(D1, '11:00') }), 403);
  expectStatus('support GET /api/admin/manifest → 200 (read allowed)', await call(support, 'GET', `/api/admin/manifest?date=${D2}`, { now: ist(D1, '11:00') }), 200);
  expectStatus('tick without bearer → 401', await call(anon, 'POST', '/api/cron/tick'), 401);
  expectStatus('tick with wrong bearer → 401', await call(anon, 'POST', '/api/cron/tick', { headers: { authorization: 'Bearer nope' } }), 401);
}

async function flowAccessCrossCustomer() {
  header('1b. access — cross-customer');
  if (!state.subA) return notVerified('B reads A subscription', 'A has no subscription (flow 2 failed)');
  expectStatus("B GET A's calendar → 404", await call(B, 'GET', `/api/subscriptions/${state.subA}/calendar`, { now: ist(D2, '07:00') }), 404);
  expectStatus("B GET A's cancel breakdown → 404", await call(B, 'GET', `/api/subscriptions/${state.subA}/cancel`, { now: ist(D2, '07:00') }), 404);
  expectStatus("B POST pause on A's plan → 404", await call(B, 'POST', `/api/subscriptions/${state.subA}/pause`, { body: { dates: [D5] }, now: ist(D2, '07:00') }), 404);
  expectStatus('A GET own calendar → 200', await call(A, 'GET', `/api/subscriptions/${state.subA}/calendar`, { now: ist(D2, '07:00') }), 200);
  if (!state.photoKey) return notVerified("B reads A's photo", 'no photo was uploaded (flow 3 failed)');
  const url = `/api/photos/${state.photoKey.split('/').map(encodeURIComponent).join('/')}`;
  const b = await call(B, 'GET', url, { binary: true });
  expectStatus("B GET A's photo → 404", b, 404);
  expectStatus("anon GET A's photo → 404", await call(anon, 'GET', url, { binary: true }), 404);
}

async function flowOnboarding() {
  header('2. onboarding');
  const now = ist(D1, '11:00');
  const inside = await call(anon, 'GET', `/api/serviceability?lat=${PIN.A.lat}&lng=${PIN.A.lng}`);
  check('serviceability inside DEV zone → yes', inside.status === 200 && inside.json?.serviceable === true, snip(inside), String(inside.json?.zone));
  const outside = await call(anon, 'GET', `/api/serviceability?lat=${PIN.OUT.lat}&lng=${PIN.OUT.lng}`);
  check('serviceability outside → no', outside.status === 200 && outside.json?.serviceable === false && !outside.json?.unknown, snip(outside));

  for (const [who, m] of [[A, CUST.A], [C, CUST.C], [Dd, CUST.D]] as const) {
    const r = await call(owner, 'POST', '/api/admin/credits', { body: { mobile: m, amountPaise: 500_000, note: 'e2e goodwill for first plan' }, now });
    expectStatus(`owner goodwill ₹5,000 → ${who.label} (201)`, r, 201);
  }
  const sup = await call(support, 'POST', '/api/admin/credits', { body: { mobile: CUST.A, amountPaise: 20_001, note: 'over the support cap' }, now });
  expectStatus('support goodwill over ₹200 cap → 403', sup, 403);

  const plan = { purpose: 'new', kind: 'cow', quantityId: 'one', tenureId: '1m', useCredit: true };
  const pv = await call(A, 'POST', '/api/checkout/preview', { body: plan, now });
  check('A /api/checkout/preview → 200 with preview', pv.status === 200 && !!pv.json?.preview, snip(pv));

  const bodyA = { ...plan, details: details('Customer A', PIN.A, '12'), whatsappOptIn: true, idempotencyKey: 'e2e-A-checkout-0001' };
  const co = await call(A, 'POST', '/api/checkout', { body: bodyA, now });
  const okCo = check('A /api/checkout (credit) → razorpay null', co.status === 200 && co.json?.razorpay === null, snip(co), String(co.json?.status));
  if (okCo) {
    const again = await call(A, 'POST', '/api/checkout', { body: bodyA, now });
    check('same idempotencyKey → same order', again.status === 200 && again.json?.orderId === co.json?.orderId, snip(again));
    const diff = await call(A, 'POST', '/api/checkout', { body: { ...bodyA, tenureId: '3m' }, now });
    expectStatus('same key + different payload → 409', diff, 409);
  }
  const sA = await subOf(CUST.A);
  if (check('A subscription created', !!sA, 'no subscription row for A', `${sA?.status} ${sA?.startDate}→${sA?.endDate}`)) {
    state.subA = String(sA!._id);
    check('A first delivery = next day', sA!.startDate === D2, `startDate ${sA!.startDate}`);
    const n = await db.collection('deliveries').countDocuments({ subscriptionId: sA!._id, status: 'planned' });
    check('A deliveries planned for the term', n === 30, `planned rows ${n}`, `${n} rows`);
  }

  for (const [who, pin, key, opt] of [[C, PIN.C, 'e2e-C-checkout-0001', true], [Dd, PIN.D, 'e2e-D-checkout-0001', false]] as const) {
    const r = await call(who, 'POST', '/api/checkout', {
      body: { purpose: 'new', kind: 'cow', quantityId: 'half', tenureId: '1m', useCredit: true, details: details(`Customer ${who.label}`, pin, '7'), whatsappOptIn: opt, idempotencyKey: key },
      now,
    });
    check(`${who.label} /api/checkout (credit) → razorpay null`, r.status === 200 && r.json?.razorpay === null, snip(r));
  }
  state.subC = String((await subOf(CUST.C))?._id ?? '');
  state.subD = String((await subOf(CUST.D))?._id ?? '');

  const outBody = { purpose: 'new', kind: 'cow', quantityId: 'half', tenureId: '1m', useCredit: true, details: details('Customer C', PIN.OUT, '9'), idempotencyKey: 'e2e-C-outside-0001' };
  const out = await call(C, 'POST', '/api/checkout', { body: outBody, now });
  check('checkout with a pin outside every zone → 400 outside_zone', out.status === 400 && out.json?.code === 'outside_zone', snip(out));

  // Customer B pays with Razorpay (test keys) — no credit.
  const bBody = { purpose: 'new', kind: 'cow', quantityId: 'half', tenureId: '1m', useCredit: false, details: details('Customer B', PIN.B, '3'), whatsappOptIn: true, idempotencyKey: 'e2e-B-checkout-0001' };
  const bco = await call(B, 'POST', '/api/checkout', { body: bBody, now });
  const rz = bco.json?.razorpay as { orderId?: string } | null | undefined;
  const secret = (process.env.RAZORPAY_KEY_SECRET ?? '').trim();
  if (bco.status === 200 && rz?.orderId && secret) {
    pass('B /api/checkout → Razorpay order created', rz.orderId);
    const paymentId = `pay_e2e${randomBytes(6).toString('hex')}`;
    const signature = createHmac('sha256', secret).update(`${rz.orderId}|${paymentId}`).digest('hex');
    const bad = await call(B, 'POST', '/api/payments/verify', { body: { razorpay_order_id: rz.orderId, razorpay_payment_id: paymentId, razorpay_signature: 'deadbeef' }, now });
    expectStatus('B verify with a bad signature → 400', bad, 400);
    const v = await call(B, 'POST', '/api/payments/verify', { body: { razorpay_order_id: rz.orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }, now });
    check('B /api/payments/verify → paid', v.status === 200 && v.json?.status === 'paid', snip(v));
    const v2 = await call(B, 'POST', '/api/payments/verify', { body: { razorpay_order_id: rz.orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }, now });
    check('B verify replay → already_paid', v2.status === 200 && v2.json?.status === 'already_paid', snip(v2));
    const vA = await call(A, 'POST', '/api/payments/verify', { body: { razorpay_order_id: rz.orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }, now });
    expectStatus("A verifying B's order → 404", vA, 404);
    state.subB = String((await subOf(CUST.B))?._id ?? '');
  } else {
    notVerified('B Razorpay payment', `checkout answered ${snip(bco)}${secret ? '' : ' (no RAZORPAY_KEY_SECRET)'}`);
  }
}

async function flowDay() {
  header('3. the day');
  const tick = await call(anon, 'POST', '/api/cron/tick?force=1', { headers: { authorization: `Bearer ${CRON_SECRET}` }, now: ist(D1, '16:05') });
  const lockStep = (tick.json?.steps as { step: string; ok: boolean; report?: { locked?: string[] }; error?: string }[] | undefined)?.find(s => s.step === 'lockDueDays');
  check(`tick ${D1} 16:05 → ${D2} locked`, tick.status === 200 && !!lockStep?.report?.locked?.includes(D2), `${snip(tick)} lockStep=${JSON.stringify(lockStep)}`);
  const failedSteps = ((tick.json?.steps as { step: string; ok: boolean; error?: string }[]) ?? []).filter(s => !s.ok);
  check('tick: every step ok', tick.status === 200 && failedSteps.length === 0, JSON.stringify(failedSteps).slice(0, 400));
  const lock = await db.collection('day_locks').findOne({ _id: D2 as unknown as ObjectId });
  check('day_locks row exists', !!lock, 'no day_locks doc', `stops=${lock?.stops}`);

  const man = await call(owner, 'GET', `/api/admin/manifest?date=${D2}`, { now: ist(D1, '16:10') });
  const runs = (man.json?.manifest as { runs?: unknown[] } | undefined)?.runs;
  check('GET /api/admin/manifest has runs', man.status === 200 && Array.isArray(runs) && runs.length > 0, `${snip(man)}`, `${runs?.length} runs`);

  const dawn = ist(D2, '06:00');
  const today = await call(rider, 'GET', '/api/rider/today', { now: dawn });
  const stops = (today.json?.stops as { mobile: string; items: { deliveryId: string }[] }[] | undefined) ?? [];
  check('rider /api/rider/today → run with stops', today.status === 200 && today.json?.hasRun === true && stops.length >= 2, snip(today), `${stops.length} stops`);
  const stopA = stops.find(s => s.mobile === CUST.A);
  const stopC = stops.find(s => s.mobile === CUST.C);
  const stopD = stops.find(s => s.mobile === CUST.D);
  check("rider 1's run excludes another zone's customer", !stopD, 'D (Malkajgiri) is on rider 1');
  state.delA = stopA?.items[0]?.deliveryId;
  state.delC = stopC?.items[0]?.deliveryId;
  if (!state.delA || !state.delC) return fail('A and C on the run', `A=${state.delA} C=${state.delC}`);

  const st = await call(rider, 'POST', '/api/rider/actions', { body: { op: 'start_run' }, now: dawn });
  check('rider start_run → in_progress', st.status === 200 && st.json?.status === 'in_progress', snip(st));

  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 240, g: 240, b: 230 } } }).jpeg({ quality: 70 }).toBuffer();
  const up = await call(rider, 'POST', `/api/rider/photos?deliveryId=${state.delA}`, { raw: jpeg, contentType: 'image/jpeg', now: ist(D2, '06:20') });
  state.photoKey = typeof up.json?.key === 'string' ? (up.json.key as string) : undefined;
  check('rider uploads a JPEG → key', up.status === 200 && !!state.photoKey, snip(up), `${jpeg.byteLength} B`);
  const upOther = await call(rider, 'POST', `/api/rider/photos?deliveryId=${new ObjectId().toHexString()}`, { raw: jpeg, contentType: 'image/jpeg', now: ist(D2, '06:20') });
  expectStatus("rider photo for a delivery not on the run → 404", upOther, 404);

  const actDel = { actionId: `e2e-del-${randomBytes(4).toString('hex')}`, type: 'delivered', deliveryId: state.delA, proof: { photoKey: state.photoKey, lat: PIN.A.lat, lng: PIN.A.lng, accuracyM: 6, capturedAt: ist(D2, '06:21') } };
  const del = await call(rider, 'POST', '/api/rider/actions', { body: { op: 'actions', actions: [actDel] }, now: ist(D2, '06:21') });
  const r0 = (del.json?.results as { ok: boolean; error?: string }[] | undefined)?.[0];
  check('rider marks A delivered (photo + GPS)', del.status === 200 && r0?.ok === true, `${snip(del)}`);
  const replay = await call(rider, 'POST', '/api/rider/actions', { body: { op: 'actions', actions: [actDel] }, now: ist(D2, '06:22') });
  const rr = (replay.json?.results as { ok: boolean; duplicate?: boolean }[] | undefined)?.[0];
  check('replayed actionId → duplicate, no second write', replay.status === 200 && rr?.duplicate === true, snip(replay));
  const dA = await db.collection('deliveries').findOne({ _id: new ObjectId(state.delA) });
  check('A row delivered, proof not flagged', dA?.status === 'delivered' && dA?.proof?.flagged !== true, JSON.stringify({ s: dA?.status, proof: dA?.proof }).slice(0, 300));

  const nd = await call(rider, 'POST', '/api/rider/actions', { body: { op: 'actions', actions: [{ actionId: `e2e-nd-${randomBytes(4).toString('hex')}`, type: 'not_delivered', deliveryId: state.delC, reason: 'out_of_stock' }] }, now: ist(D2, '06:30') });
  const n0 = (nd.json?.results as { ok: boolean; error?: string }[] | undefined)?.[0];
  check('rider marks C not delivered (out_of_stock)', nd.status === 200 && n0?.ok === true, snip(nd));
  const dC = await db.collection('deliveries').findOne({ _id: new ObjectId(state.delC) });
  check('C miss: fault ours → make-up day', dC?.status === 'not_delivered' && dC?.fault === 'ours' && dC?.resolution === 'makeup_day' && !!dC?.compensationDeliveryId,
    JSON.stringify({ s: dC?.status, f: dC?.fault, r: dC?.resolution, c: dC?.compensationDeliveryId }));
  if (dC?.compensationDeliveryId) {
    const mk = await db.collection('deliveries').findOne({ _id: dC.compensationDeliveryId });
    check('make-up row appended after endDate', mk?.source === 'makeup' && mk?.status === 'planned', JSON.stringify({ src: mk?.source, st: mk?.status, date: mk?.date }), mk?.date);
  }

  if (state.photoKey) {
    const url = `/api/photos/${state.photoKey.split('/').map(encodeURIComponent).join('/')}`;
    const pa = await call(A, 'GET', url, { binary: true });
    check('A fetches own photo → 200 image', pa.status === 200 && (pa.headers.get('content-type') ?? '').startsWith('image/') && (pa.bytes?.byteLength ?? 0) === jpeg.byteLength,
      `${pa.status} ${pa.headers.get('content-type')} ${pa.bytes?.byteLength}B`);
    const pb = await call(B, 'GET', url, { binary: true });
    expectStatus('B fetches A photo → 404', pb, 404);
    const po = await call(support, 'GET', url, { binary: true });
    expectStatus('support fetches the photo → 200', po, 200);
  }
}

async function flowCustomer() {
  header('4. customer');
  if (!state.subA) return notVerified('customer flow', 'A has no subscription');
  const now = ist(D2, '07:00');
  const p1 = await call(A, 'POST', `/api/subscriptions/${state.subA}/pause`, { body: { dates: [D5] }, now });
  expectStatus(`pause open date ${D5} → 200`, p1, 200);
  const p2 = await call(A, 'POST', `/api/subscriptions/${state.subA}/pause`, { body: { dates: [D2] }, now });
  check(`pause locked date ${D2} → 409 date_locked`, p2.status === 409 && p2.json?.code === 'date_locked', snip(p2));

  const ex = await call(A, 'POST', '/api/extras', { body: { subscriptionId: state.subA, date: D4, kind: 'cow', litres: 1, useCredit: true, idempotencyKey: 'e2e-A-extra-0001' }, now });
  check('extra milk from credit → 201, razorpay null', ex.status === 201 && ex.json?.razorpay === null, snip(ex));
  const exRow = await db.collection('deliveries').findOne({ subscriptionId: new ObjectId(state.subA), date: D4, source: 'extra' });
  check('extra delivery row exists', !!exRow, 'no extra row', exRow?.status as string);
  const ex2 = await call(A, 'POST', '/api/extras', { body: { subscriptionId: state.subA, date: D2, kind: 'cow', litres: 1, useCredit: true, idempotencyKey: 'e2e-A-extra-0002' }, now });
  check('extra on a locked date → 409', ex2.status === 409, snip(ex2));

  const pref = await call(A, 'POST', '/api/account/preferences', { body: { notifyDailyDelivered: true, lang: 'en' }, now });
  check('POST /api/account/preferences → 200', pref.status === 200 && (pref.json?.profile as { notifyDailyDelivered?: boolean })?.notifyDailyDelivered === true, snip(pref));
  const prefBad = await call(A, 'POST', '/api/account/preferences', { body: { lang: 'fr' }, now });
  check('preferences invalid → 400 with issues', prefBad.status === 400 && Array.isArray(prefBad.json?.issues), snip(prefBad));
  const addr = await call(A, 'POST', '/api/account/address', { body: { location: PIN.A2, addressParts: { house: '14', area: 'Safilguda' }, landmark: 'near the water tank' }, now });
  check('POST /api/account/address → 200', addr.status === 200 && typeof addr.json?.effectiveFrom === 'string', snip(addr), `from ${addr.json?.effectiveFrom}`);
  const addrOut = await call(A, 'POST', '/api/account/address', { body: { location: PIN.OUT, addressParts: { house: '14' } }, now });
  expectStatus('address outside zones → 400', addrOut, 400);
  if (state.delA) {
    const t = await call(A, 'POST', '/api/account/tickets', { body: { deliveryId: state.delA, kind: 'quantity', note: 'e2e: bottle looked half full' }, now });
    expectStatus('POST /api/account/tickets → 201', t, 201);
    const t2 = await call(A, 'POST', '/api/account/tickets', { body: { deliveryId: state.delA, kind: 'quantity', note: 'again' }, now });
    expectStatus('second open ticket on same delivery → 409', t2, 409);
    const tB = await call(B, 'POST', '/api/account/tickets', { body: { deliveryId: state.delA, kind: 'other', note: 'not mine' }, now });
    expectStatus("B ticket on A's delivery → 404", tB, 404);
  }

  const bd = await call(A, 'GET', `/api/subscriptions/${state.subA}/cancel`, { now });
  check('cancel breakdown → 200', bd.status === 200 && !!bd.json?.breakdown, snip(bd), `effective ${bd.json?.effectiveDate}`);
  const noConfirm = await call(A, 'POST', `/api/subscriptions/${state.subA}/cancel`, { body: {}, now });
  expectStatus('cancel without confirm → 400', noConfirm, 400);
  const brA = bd.json?.breakdown as { toSourcePaise: number; toCreditPaise: number } | undefined;
  const cx = await call(A, 'POST', `/api/subscriptions/${state.subA}/cancel`, { body: { confirm: true, reason: 'e2e' }, now });
  expectStatus('cancel {confirm:true} → 200', cx, 200);
  const sub = await db.collection('subscriptions').findOne({ _id: new ObjectId(state.subA) });
  check('subscription cancelled', sub?.status === 'cancelled', `status ${sub?.status}`);
  // A paid 100 % from credit: nothing goes back to a payment, the balance returns to credit.
  const refundA = await db.collection('refunds').findOne({ subscriptionId: new ObjectId(state.subA) });
  const balA = await db.collection('credits').findOne({ mobile: CUST.A, kind: 'cancellation_balance' });
  check('credit-paid plan: no refund row, balance back to credit = breakdown',
    !refundA && brA?.toSourcePaise === 0 && !!balA && balA.amountPaise === brA?.toCreditPaise,
    JSON.stringify({ refundA: !!refundA, brA, credit: balA?.amountPaise }), `₹${(balA?.amountPaise as number) / 100} to credit`);
  const msgA = await db.collection('outbox').findOne({ dedupeKey: `cancel:${state.subA}` });
  check('cancellation message states the credit returned', /credit/.test(String(msgA?.params?.refund ?? '')), `refund param "${msgA?.params?.refund}"`, String(msgA?.params?.refund));
  const cx2 = await call(A, 'POST', `/api/subscriptions/${state.subA}/cancel`, { body: { confirm: true }, now });
  check('cancel replay → idempotent 200 cancelled', cx2.status === 200 && cx2.json?.status === 'cancelled', snip(cx2));
  const bd2 = await call(A, 'GET', `/api/subscriptions/${state.subA}/cancel`, { now });
  expectStatus('breakdown on a cancelled plan → 409', bd2, 409);

  // B paid through Razorpay: the part of the balance up to the payment is a refund row.
  if (!state.subB) return notVerified('cancel → refund row (Razorpay-paid plan)', 'B has no paid plan (Razorpay not verified)');
  const bdB = await call(B, 'GET', `/api/subscriptions/${state.subB}/cancel`, { now });
  const brB = bdB.json?.breakdown as { toSourcePaise: number; chargedDays: number } | undefined;
  check('B cancel breakdown → toSource > 0', bdB.status === 200 && (brB?.toSourcePaise ?? 0) > 0, snip(bdB), `₹${(brB?.toSourcePaise ?? 0) / 100}, ${brB?.chargedDays} charged days`);
  const cxB = await call(B, 'POST', `/api/subscriptions/${state.subB}/cancel`, { body: { confirm: true }, now });
  check('B cancel → 200 with refundId', cxB.status === 200 && typeof cxB.json?.refundId === 'string', snip(cxB));
  const refundB = await db.collection('refunds').findOne({ subscriptionId: new ObjectId(state.subB) });
  check('refund row created = breakdown.toSourcePaise', !!refundB && refundB.amountPaise === brB?.toSourcePaise,
    JSON.stringify({ amount: refundB?.amountPaise, want: brB?.toSourcePaise }), refundB ? `${refundB.status} ${refundB.method} ₹${(refundB.amountPaise as number) / 100}` : '');
}

async function flowAdminCrm() {
  header('5b. admin customers & finance APIs');
  const now = ist(D3, '12:20');
  const list = await call(support, 'GET', '/api/admin/customers?q=98100', { now });
  const custs = (list.json?.customers as { mobile?: string }[] | undefined) ?? [];
  check('support GET /api/admin/customers?q= → our customers', list.status === 200 && custs.some(c => c.mobile === CUST.A), snip(list), `${custs.length} rows`);
  const det = await call(ops, 'GET', `/api/admin/customers/${CUST.A}`, { now });
  expectStatus('ops GET /api/admin/customers/<A> → 200', det, 200);
  expectStatus('GET /api/admin/customers/<unknown> → 404', await call(owner, 'GET', '/api/admin/customers/9899999999', { now }), 404);
  expectStatus('customer A GET /api/admin/customers → 403', await call(A, 'GET', '/api/admin/customers', { now }), 403);
  const ord = await call(support, 'GET', '/api/admin/orders', { now });
  const orders = (ord.json?.orders as unknown[] | undefined) ?? [];
  check('support GET /api/admin/orders → rows', ord.status === 200 && orders.length >= 4, snip(ord), `${orders.length} orders`);
  expectStatus('GET /api/admin/orders?status=bogus → 400', await call(owner, 'GET', '/api/admin/orders?status=bogus', { now }), 400);
  expectStatus('GET /api/admin/orders?status=abandoned → 200', await call(owner, 'GET', '/api/admin/orders?status=abandoned', { now }), 200);
  const rf = await call(support, 'GET', '/api/admin/refunds', { now });
  expectStatus('support GET /api/admin/refunds → 200', rf, 200);
  expectStatus('owner GET /api/admin/staff → 200', await call(owner, 'GET', '/api/admin/staff', { now }), 200);
  expectStatus('ops GET /api/admin/staff → 403', await call(ops, 'GET', '/api/admin/staff', { now }), 403);
  expectStatus('ops POST /api/admin/staff → 403', await call(ops, 'POST', '/api/admin/staff', { body: { mobile: '9800000077', name: 'Sneaky', role: 'owner' }, now }), 403);
  const add = await call(owner, 'POST', '/api/admin/staff', { body: { mobile: '9800000055', name: 'E2E Support Two', role: 'support' }, now });
  expectStatus('owner POST /api/admin/staff (support) → 201', add, 201);
  const bad = await call(owner, 'POST', '/api/admin/staff', { body: { mobile: '12', name: '', role: 'king' }, now });
  expectStatus('owner POST /api/admin/staff invalid → 400', bad, 400);
}

async function tick(nowIso: string) {
  return call(anon, 'POST', '/api/cron/tick?force=1', { headers: { authorization: `Bearer ${CRON_SECRET}` }, now: nowIso });
}

async function flowClose() {
  header('5. close');
  const subD = state.subD ? new ObjectId(state.subD) : null;
  const t1 = await tick(ist(D2, '10:05'));
  expectStatus(`tick ${D2} 10:05 → 200`, t1, 200);
  const dD = subD ? await db.collection('deliveries').findOne({ subscriptionId: subD, date: D2, source: 'plan' }) : null;
  check(`D's unmarked ${D2} row → unconfirmed`, dD?.status === 'unconfirmed', `status ${dD?.status}`);
  const lock = await db.collection('day_locks').findOne({ _id: D2 as unknown as ObjectId });
  check('day_locks closedAt set', !!lock?.closedAt, JSON.stringify(lock).slice(0, 200));

  const t2 = await tick(ist(D3, '10:05'));
  expectStatus(`tick ${D3} 10:05 → 200`, t2, 200);
  const dD2 = dD?._id ? await db.collection('deliveries').findOne({ _id: dD._id }) : null;
  check('after 24 h: not delivered, fault ours, compensated',
    dD2?.status === 'not_delivered' && dD2?.fault === 'ours' && (dD2?.resolution === 'makeup_day' || dD2?.resolution === 'credit'),
    JSON.stringify({ s: dD2?.status, f: dD2?.fault, r: dD2?.resolution, reason: dD2?.reason }), String(dD2?.resolution));

  const zone = await db.collection('zones').findOne({ name: 'DEV Malkajgiri' });
  state.malkajgiriId = zone?._id ? String(zone._id) : undefined;
  const dis = await call(owner, 'POST', '/api/admin/disruptions', { body: { date: D4, zoneIds: state.malkajgiriId ? [state.malkajgiriId] : [], reason: 'e2e: flooding in Malkajgiri' }, now: ist(D3, '12:00') });
  check(`POST /api/admin/disruptions ${D4} → affected ≥ 1`, dis.status === 200 && typeof dis.json?.affected === 'number' && (dis.json.affected as number) >= 1, snip(dis), `affected ${dis.json?.affected}`);
  const disOps = await call(ops, 'POST', '/api/admin/disruptions', { body: { date: '2031-03-01', reason: 'past date' }, now: ist(D3, '12:00') });
  expectStatus('ops disruption on a past date → 400', disOps, 400);

  const s1 = await call(owner, 'PUT', '/api/admin/settings', { body: { cutoffTime: '17:00' }, now: ist(D3, '12:00') });
  check('owner PUT cutoffTime 17:00 → 200', s1.status === 200 && (s1.json?.settings as { cutoffTime?: string })?.cutoffTime === '17:00', snip(s1));
  const s2 = await call(owner, 'PUT', '/api/admin/settings', { body: { cutoffTime: '25:99' }, now: ist(D3, '12:00') });
  check('owner PUT invalid → 400 with issues', s2.status === 400 && Array.isArray(s2.json?.issues) && (s2.json.issues as unknown[]).length > 0, snip(s2));
  const s3 = await call(owner, 'PUT', '/api/admin/settings', { body: { bogusKey: 1 }, now: ist(D3, '12:00') });
  check('owner PUT unknown key → 400', s3.status === 400, snip(s3));
  expectStatus('ops PUT settings → 403', await call(ops, 'PUT', '/api/admin/settings', { body: { cutoffTime: '15:00' }, now: ist(D3, '12:00') }), 403);
  expectStatus('support GET settings → 200', await call(support, 'GET', '/api/admin/settings'), 200);
  const restore = await call(owner, 'PUT', '/api/admin/settings', { body: { cutoffTime: '16:00' }, now: ist(D3, '12:00') });
  expectStatus('owner restores cutoffTime 16:00', restore, 200);
}

async function flowMessages() {
  header('6. messages');
  const t = await tick(ist(D3, '12:05'));
  expectStatus('tick (drain outbox) → 200', t, 200);
  const r = await call(owner, 'GET', '/api/admin/messages', { now: ist(D3, '12:10') });
  const rows = (r.json?.messages as { mobile: string; status: string; template: string }[] | undefined) ?? [];
  check('GET /api/admin/messages → rows', r.status === 200 && rows.length > 0, snip(r), `${rows.length} rows`);
  const summary = (m: string) => rows.filter(x => x.mobile === m).map(x => `${x.template}:${x.status}`).join(', ');
  const aRows = rows.filter(x => x.mobile === CUST.A);
  const dRows = rows.filter(x => x.mobile === CUST.D);
  check('opted-in A has logged rows, none suppressed', aRows.length > 0 && aRows.some(x => x.status === 'logged') && !aRows.some(x => x.status === 'suppressed'), `A: ${summary(CUST.A) || 'none'}`, summary(CUST.A));
  check('opted-out D rows all suppressed', dRows.length > 0 && dRows.every(x => x.status === 'suppressed'), `D: ${summary(CUST.D) || 'none'}`, summary(CUST.D));
  const queued = rows.filter(x => x.status === 'queued');
  check('nothing left queued after a drain', queued.length === 0, queued.map(x => `${x.mobile}:${x.template}`).join(', '));
  expectStatus('customer A GET /api/admin/messages → 403', await call(A, 'GET', '/api/admin/messages'), 403);
}

async function page(who: Actor | null, url: string) {
  let r: Res;
  try {
    r = await call(who, 'GET', url, { now: ist(D3, '12:30') });
  } catch (err) {
    return fail(`${url} as ${who?.label ?? 'anon'}`, `request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const marker = ERROR_MARKERS.find(m => r.text.includes(m));
  const loc = r.headers.get('location');
  check(`${url} as ${who?.label ?? 'anon'} → 200, no error text`, r.status === 200 && !marker,
    `${r.status}${loc ? ` → ${loc}` : ''}${marker ? ` contains "${marker}"` : ''} ${r.text.replace(/\s+/g, ' ').slice(0, 120)}`);
}

async function flowPages() {
  header('7. page smoke');
  for (const u of ['/', '/plans', '/subscribe', '/legal/terms', '/legal/privacy', '/legal/refunds', '/legal/shipping']) await page(anon, u);
  await page(A, '/account');
  await page(C, '/account');
  await page(rider, '/rider');
  for (const u of ['/admin', '/admin/tomorrow', '/admin/exceptions', '/admin/riders', '/admin/routes', '/admin/disruptions', '/admin/settings']) await page(owner, u);
  await page(support, '/admin');
  header('7b. page smoke — admin customers & finance');
  for (const u of ['/admin/customers', `/admin/customers/${CUST.A}`, '/admin/orders', '/admin/refunds', '/admin/subscriptions', '/admin/messages', '/admin/staff']) await page(owner, u);
  await page(support, '/admin/customers');
}

/* ================================================================= main == */

async function main() {
  header('setup');
  await resetDb();
  const t0 = Date.now();
  await startServer();
  pass('next dev ready', `${Math.round((Date.now() - t0) / 1000)} s · log ${logPath}`);
  for (const a of [owner, ops, support, rider, A, B, C, Dd]) await signIn(a);
  pass('signed in 8 actors');

  const flows: [number, () => Promise<void>][] = [
    [1, flowAccess],
    [2, flowOnboarding],
    [3, flowDay],
    [1, flowAccessCrossCustomer],
    [4, flowCustomer],
    [5, flowClose],
    [5, flowAdminCrm],
    [6, flowMessages],
    [7, flowPages],
  ];
  for (const [n, fn] of flows) {
    if (!want(n)) continue;
    try {
      await fn();
    } catch (err) {
      fail(`${flow}: aborted`, err instanceof Error ? `${err.message}` : String(err));
    }
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  fail('harness', err instanceof Error ? err.message : String(err));
} finally {
  killChild();
  await mongo?.close().catch(() => undefined);
  const p = steps.filter(s => s.ok === true).length;
  const f = steps.filter(s => s.ok === false);
  const n = steps.filter(s => s.ok === null).length;
  console.log(`\n== totals: ${p} pass · ${f.length} fail · ${n} not verified  (server log: ${logPath})`);
  for (const s of f) console.log(`  FAIL [${s.flow}] ${s.name} — ${s.detail}`);
  const serverErrors = childLog.split('\n').filter(l => /\[api\] unhandled|⨯|Error:/.test(l)).slice(-15);
  if (serverErrors.length) console.log(`\n-- server error lines (last ${serverErrors.length}):\n${serverErrors.join('\n')}`);
  exitCode = f.length ? 1 : 0;
  if (!existsSync(logPath)) console.log('(no server log)');
}
process.exit(exitCode);
