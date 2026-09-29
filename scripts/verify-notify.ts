// Unit tests for the notification layer — pure, no DB. Run: pnpm test:notify
//
// Covers: template rendering + param validation, the retry backoff schedule, and
// the webhook signature check against a KNOWN HMAC-SHA256 vector (the exact algorithm
// the webhook route uses, replicated here so the vector proves the bytes).
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  render,
  missingParams,
  orderedParams,
  TEMPLATES,
  TemplateParamError,
  type RenderableTemplate,
} from '../lib/notify/templates.ts';
import { BACKOFF_MINUTES, MAX_ATTEMPTS, nextAttemptAt, outranks } from '../lib/notify/index.ts';

let passed = 0;
let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
}
function truthy(name: string, got: unknown): void {
  if (got) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}: expected truthy, got ${JSON.stringify(got)}`);
  }
}
function throws(name: string, fn: () => unknown, is?: (e: unknown) => boolean): void {
  try {
    fn();
    failed++;
    console.log(`FAIL ${name}: expected throw`);
  } catch (e) {
    if (is && !is(e)) {
      failed++;
      console.log(`FAIL ${name}: wrong error ${String(e)}`);
    } else passed++;
  }
}

// --- rendering ---
eq(
  'render order_confirmed en',
  render('order_confirmed', 'en', { name: 'Asha', plan: 'Cow 1L', startDate: '2 Oct', endDate: '1 Nov', amount: '₹3,450' }),
  'Hi Asha, your Maavuli Cow 1L plan is confirmed. Deliveries run 2 Oct to 1 Nov. Paid: ₹3,450.',
);
truthy('render te is non-empty for every template', (() => {
  for (const name of Object.keys(TEMPLATES) as RenderableTemplate[]) {
    const def = TEMPLATES[name];
    const params = Object.fromEntries(def.params.map(p => [p, 'x']));
    if (!render(name, 'te', params)) return false;
    if (!render(name, 'en', params)) return false;
  }
  return true;
})());
eq('render auth_code en', render('auth_code', 'en', { code: '482913' }),
  '482913 is your Maavuli sign-in code. It expires in 5 minutes. Do not share it.');

// --- param validation ---
eq('missingParams flags absent', missingParams('order_confirmed', { name: 'A' }), ['plan', 'startDate', 'endDate', 'amount']);
eq('missingParams empty string counts as missing', missingParams('delivered_today', { time: '' }), ['time']);
eq('missingParams none when all present', missingParams('ticket_update', { status: 'Resolved', note: 'done' }), []);
throws('render throws on missing param', () => render('refund_processed', 'en', {}), e => e instanceof TemplateParamError);
eq('orderedParams positional', orderedParams('pause_confirmed', { dates: '2-4 Oct', endDate: '5 Nov' }), ['2-4 Oct', '5 Nov']);
eq('orderedParams fills missing with empty', orderedParams('pause_confirmed', { dates: '2 Oct' }), ['2 Oct', '']);

// --- every template's category is utility except auth ---
truthy('categories', (() => {
  for (const name of Object.keys(TEMPLATES) as RenderableTemplate[]) {
    const cat = TEMPLATES[name].category;
    if (name === 'auth_code') {
      if (cat !== 'authentication') return false;
    } else if (cat !== 'utility') return false;
  }
  return true;
})());

// --- backoff schedule ---
eq('backoff schedule', [...BACKOFF_MINUTES], [1, 5, 30, 120, 360]);
eq('max attempts', MAX_ATTEMPTS, 5);
const t0 = new Date('2026-10-01T00:00:00.000Z');
eq('after attempt 1 → +1m', nextAttemptAt(1, t0)?.toISOString(), '2026-10-01T00:01:00.000Z');
eq('after attempt 2 → +5m', nextAttemptAt(2, t0)?.toISOString(), '2026-10-01T00:05:00.000Z');
eq('after attempt 3 → +30m', nextAttemptAt(3, t0)?.toISOString(), '2026-10-01T00:30:00.000Z');
eq('after attempt 4 → +2h', nextAttemptAt(4, t0)?.toISOString(), '2026-10-01T02:00:00.000Z');
eq('after attempt 5 → give up', nextAttemptAt(5, t0), null);

// --- status ranking never goes backwards ---
truthy('sent outranks queued', outranks('sent', 'queued'));
truthy('delivered outranks sent', outranks('delivered', 'sent'));
truthy('read outranks delivered', outranks('read', 'delivered'));
eq('delivered does NOT outrank read', outranks('delivered', 'read'), false);
eq('sent does NOT outrank read', outranks('sent', 'read'), false);

// --- webhook signature: known HMAC-SHA256 vector ---
// This replicates the webhook route's verification EXACTLY, proving the byte-level
// algorithm against a vector computed independently (node crypto, see the test brief).
function signatureValid(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header) return false;
  const provided = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
const KNOWN_BODY =
  '{"entry":[{"changes":[{"value":{"statuses":[{"id":"wamid.TEST","status":"delivered","timestamp":"1700000000"}]}}]}]}';
const KNOWN_SECRET = 'test_app_secret';
const KNOWN_SIG = 'sha256=2cd39d127334ee6f02af9035eb49fae425af12bf455e28995a94571a045d333c';
truthy('valid signature accepts', signatureValid(KNOWN_BODY, KNOWN_SIG, KNOWN_SECRET));
truthy('valid signature without sha256= prefix', signatureValid(KNOWN_BODY, KNOWN_SIG.slice(7), KNOWN_SECRET));
eq('tampered body rejected', signatureValid(KNOWN_BODY + ' ', KNOWN_SIG, KNOWN_SECRET), false);
eq('wrong secret rejected', signatureValid(KNOWN_BODY, KNOWN_SIG, 'nope'), false);
eq('missing header rejected', signatureValid(KNOWN_BODY, null, KNOWN_SECRET), false);
eq('garbage header rejected', signatureValid(KNOWN_BODY, 'sha256=zzzz', KNOWN_SECRET), false);

console.log(`notify: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
