/**
 * Assertions for the AiSensy WhatsApp integration — provider, response handling,
 * webhook signature and payload parsing. No network, no database.
 *
 *   pnpm test:aisensy
 */
import { createHmac } from 'node:crypto';
import {
  aisensyConfig,
  aisensyProvider,
  buildAisensyPayload,
  campaignNameFor,
  interpretAisensyResponse,
  sendLang,
  toDestination,
  __setAisensyFetchForTests,
  DEFAULT_AISENSY_URL,
  type AisensyConfig,
} from '../lib/notify/providers/aisensy';
import { resolveProvider } from '../lib/notify/providers';
import { aisensySignatureValid, parseAisensyNotification, toDate } from '../lib/notify/aisensy-webhook';
import { intentOf } from '../lib/notify/inbound';
import { absoluteLinks, outranks } from '../lib/notify';
import { ServiceNotConfiguredError } from '../lib/errors';

let pass = 0;
const fails: string[] = [];
const ok = (label: string, cond: boolean) => (cond ? pass++ : fails.push(label));
const eq = (label: string, got: unknown, want: unknown) =>
  ok(`${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want));
const throwsConfig = (label: string, fn: () => unknown) => {
  try {
    fn();
    ok(`${label}: expected a configuration error`, false);
  } catch (e) {
    ok(label, e instanceof ServiceNotConfiguredError);
  }
};

const ENV_KEYS = ['AISENSY_API_KEY', 'AISENSY_LANGUAGES', 'AISENSY_CAMPAIGNS', 'AISENSY_CAMPAIGN_PREFIX', 'AISENSY_API_URL', 'WHATSAPP_PROVIDER', 'NODE_ENV'];
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const setEnv = (vals: Record<string, string | undefined>) => {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vals)) if (v !== undefined) process.env[k] = v;
};

/* ---- configuration ---- */
setEnv({});
throwsConfig('no API key → configuration error', () => aisensyConfig());
setEnv({ AISENSY_API_KEY: 'k' });
const base = aisensyConfig();
eq('default languages = en only', base.languages, ['en']);
eq('default endpoint', base.url, DEFAULT_AISENSY_URL);
setEnv({ AISENSY_API_KEY: 'k', AISENSY_LANGUAGES: 'te' });
eq('English is always kept as the fallback', aisensyConfig().languages, ['en', 'te']);
setEnv({ AISENSY_API_KEY: 'k', AISENSY_CAMPAIGNS: '{not json' });
throwsConfig('malformed AISENSY_CAMPAIGNS → configuration error', () => aisensyConfig());
setEnv({ AISENSY_API_KEY: 'k', AISENSY_CAMPAIGNS: '["a"]' });
throwsConfig('AISENSY_CAMPAIGNS must be an object', () => aisensyConfig());

/* ---- campaign names ---- */
const cfg: AisensyConfig = { apiKey: 'KEY123', url: 'https://example.test/api', languages: ['en'], overrides: {}, prefix: '' };
eq('convention name', campaignNameFor('order_confirmed', 'en', cfg), 'order_confirmed_en');
eq('Telugu customer falls back to English until Telugu is live', campaignNameFor('order_confirmed', 'te', cfg), 'order_confirmed_en');
eq('sendLang fallback', sendLang('te', cfg), 'en');
const cfgTe = { ...cfg, languages: ['en', 'te'] as const as AisensyConfig['languages'] };
eq('Telugu name once enabled', campaignNameFor('order_confirmed', 'te', cfgTe), 'order_confirmed_te');
eq('prefix applied', campaignNameFor('auth_code', 'en', { ...cfg, prefix: 'mv_' }), 'mv_auth_code_en');
const cfgOv = { ...cfgTe, overrides: { order_confirmed: 'Order OK', 'order_confirmed:te': 'Order OK TE' } };
eq('template:lang override wins', campaignNameFor('order_confirmed', 'te', cfgOv), 'Order OK TE');
eq('template override applies to other languages', campaignNameFor('order_confirmed', 'en', cfgOv), 'Order OK');
eq('photo variant name', campaignNameFor('delivered_today', 'en', cfg, { withImage: true }), 'delivered_today_photo_en');
eq('photo variant override', campaignNameFor('delivered_today', 'en', { ...cfg, overrides: { delivered_today_photo: 'Photo' } }, { withImage: true }), 'Photo');

/* ---- destination ---- */
eq('10-digit → +91', toDestination('9876543210'), '+919876543210');
eq('already 91-prefixed', toDestination('919876543210'), '+919876543210');

/* ---- payloads ---- */
const order = buildAisensyPayload(
  {
    mobile: '9876543210',
    template: 'order_confirmed',
    lang: 'en',
    params: { amount: '₹3,450', name: 'Anitha', endDate: 'Sat 12 Dec', plan: 'Cow 1 L', startDate: 'Fri 13 Nov' },
    userName: '  Anitha   Rao ',
  },
  cfg,
);
eq('params follow the template order, not object order', order.templateParams, ['Anitha', 'Cow 1 L', 'Fri 13 Nov', 'Sat 12 Dec', '₹3,450']);
eq('userName tidied', order.userName, 'Anitha Rao');
eq('apiKey in body', order.apiKey, 'KEY123');
ok('no buttons on a utility message', order.buttons === undefined);
ok('no media without an image', order.media === undefined);
const noName = buildAisensyPayload({ mobile: '9876543210', template: 'refund_processed', lang: 'en', params: { amount: '₹10' } }, cfg);
eq('userName falls back when unknown', noName.userName, 'Maavuli customer');
const otp = buildAisensyPayload({ mobile: '9876543210', template: 'auth_code', lang: 'en', params: { code: '482913' } }, cfg);
eq('OTP param', otp.templateParams, ['482913']);
eq('OTP copy-code button carries the code', otp.buttons, [{ type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: '482913' }] }]);
eq('OTP campaign', otp.campaignName, 'auth_code_en');
const photo = buildAisensyPayload(
  { mobile: '9876543210', template: 'delivered_today', lang: 'en', params: { time: '6:42 AM' }, mediaUrl: 'https://x.test/p.jpg' },
  cfg,
);
eq('photo goes to the photo campaign', photo.campaignName, 'delivered_today_photo_en');
eq('media attached', photo.media, { url: 'https://x.test/p.jpg', filename: 'maavuli-delivery.jpg' });
const textOnly = buildAisensyPayload({ mobile: '9876543210', template: 'delivered_today', lang: 'en', params: { time: '6:42 AM' } }, cfg);
eq('no photo → text-only campaign', textOnly.campaignName, 'delivered_today_en');

/* ---- responses ---- */
const rc = { campaignName: 'order_confirmed_en', mobile: '9876543210', nowMs: 1700000000000 };
const r200id = interpretAisensyResponse(200, { success: 'true', submitted_message_id: 'abc-1' }, rc);
ok('200 with an id → sent, id kept', r200id.ok && r200id.providerMessageId === 'abc-1' && r200id.providerRef === 'order_confirmed_en');
const r200 = interpretAisensyResponse(200, { success: true }, rc);
ok('200 without an id → sent, synthetic id, campaign recorded', r200.ok && r200.providerMessageId === 'aisensy:order_confirmed_en:9876543210:1700000000000' && r200.providerRef === 'order_confirmed_en');
const r200nested = interpretAisensyResponse(201, { data: { messageId: 'm-9' } }, rc);
ok('id under data', r200nested.ok && r200nested.providerMessageId === 'm-9');
const r200fail = interpretAisensyResponse(200, { success: 'false', message: 'Campaign is not live' }, rc);
ok('200 + success:false → permanent, message kept', !r200fail.ok && !r200fail.retryable && r200fail.error.includes('Campaign is not live'));
const r400 = interpretAisensyResponse(400, { message: 'Invalid template params' }, rc);
ok('400 → permanent with detail', !r400.ok && !r400.retryable && r400.error.includes('Invalid template params') && r400.error.includes('order_confirmed_en'));
for (const s of [401, 403, 429, 500, 502, 503]) {
  const r = interpretAisensyResponse(s, 'oops', rc);
  ok(`${s} → retryable`, !r.ok && r.retryable);
}

/* ---- the provider end to end, through the fetch seam ---- */
setEnv({ AISENSY_API_KEY: 'SECRETKEY', AISENSY_API_URL: 'https://aisensy.test/send/' });
const seen: { last?: { url: string; body: Record<string, unknown> } } = {};
__setAisensyFetchForTests(async (url, init) => {
  seen.last = { url, body: JSON.parse(String(init.body)) };
  return new Response(JSON.stringify({ success: 'true' }), { status: 200 });
});
const sent = await aisensyProvider.send({ mobile: '9876543210', template: 'pause_confirmed', lang: 'te', params: { dates: 'Sat 14 Nov', endDate: 'Wed 10 Feb' }, userName: 'Ravi' });
ok('provider send → ok', sent.ok);
eq('endpoint (trailing slash trimmed)', seen.last?.url, 'https://aisensy.test/send');
eq('Telugu customer, English campaign (Telugu not live)', seen.last?.body.campaignName, 'pause_confirmed_en');
eq('destination sent', seen.last?.body.destination, '+919876543210');
eq('params sent', seen.last?.body.templateParams, ['Sat 14 Nov', 'Wed 10 Feb']);
const calls = { n: 0 };
__setAisensyFetchForTests(async () => {
  calls.n++;
  return new Response('{}', { status: 200 });
});
const missing = await aisensyProvider.send({ mobile: '9876543210', template: 'pause_confirmed', lang: 'en', params: { dates: 'Sat 14 Nov' } });
ok('missing param → permanent, no call made', !missing.ok && !missing.retryable && calls.n === 0 && missing.error.includes('endDate'));
__setAisensyFetchForTests(async () => {
  throw new TypeError('fetch failed: SECRETKEY');
});
const down = await aisensyProvider.send({ mobile: '9876543210', template: 'refund_processed', lang: 'en', params: { amount: '₹10' } });
ok('network failure → retryable', !down.ok && down.retryable);
ok('API key never leaks into the error', !down.ok && !down.error.includes('SECRETKEY'));
__setAisensyFetchForTests(undefined);

/* ---- provider selection ---- */
setEnv({ WHATSAPP_PROVIDER: 'aisensy', AISENSY_API_KEY: 'k' });
eq('WHATSAPP_PROVIDER=aisensy selects it', resolveProvider().name, 'aisensy');
setEnv({ WHATSAPP_PROVIDER: 'aisensy-typo' });
let threw = false;
try {
  resolveProvider();
} catch {
  threw = true;
}
ok('unknown provider still refused', threw);

/* ---- links, ranking ---- */
eq('relative link made absolute', absoluteLinks({ link: '/account', amount: '₹1' }, 'https://maavuli.test/'), { link: 'https://maavuli.test/account', amount: '₹1' });
eq('no site → left alone', absoluteLinks({ link: '/account' }, ''), { link: '/account' });
eq('absolute link untouched', absoluteLinks({ link: 'https://x.test/a' }, 'https://maavuli.test'), { link: 'https://x.test/a' });
ok('failed outranks sent (a failure after acceptance shows)', outranks('failed', 'sent'));
ok('delivered outranks failed', outranks('delivered', 'failed'));
ok('a late sent cannot undo failed', !outranks('sent', 'failed'));

/* ---- webhook signature ---- */
const secret = 'whsec_test';
const compact = JSON.stringify({ id: 'n1', topic: 'message.status.updated', data: { message: { phone_number: '919876543210', status: 'DELIVERED' } } });
const sig = (s: string) => createHmac('sha256', secret).update(s).digest('hex');
ok('signature over the raw body', aisensySignatureValid(compact, sig(compact), secret));
const pretty = JSON.stringify(JSON.parse(compact), null, 2);
ok('signature over the compact form of a pretty body', aisensySignatureValid(pretty, sig(compact), secret));
ok('wrong secret refused', !aisensySignatureValid(compact, createHmac('sha256', 'other').update(compact).digest('hex'), secret));
ok('missing header refused', !aisensySignatureValid(compact, null, secret));
ok('non-hex header refused', !aisensySignatureValid(compact, 'not-a-signature', secret));
ok('sha256= prefix tolerated', aisensySignatureValid(compact, `sha256=${sig(compact)}`, secret));

/* ---- webhook payloads ---- */
const now = new Date('2026-11-13T05:00:00Z');
const delivered = parseAisensyNotification(
  {
    id: 'n1',
    created_at: 1794465000000,
    topic: 'message.status.updated',
    data: { message: { id: 'evt-1', messageId: 'msg-1', phone_number: '919876543210', campaign: { name: 'order_confirmed_en' }, status: 'DELIVERED', delivered_at: 1794465100000 } },
  },
  now,
);
ok(
  'status: delivered, ids, campaign, time',
  delivered.kind === 'status' &&
    delivered.status === 'delivered' &&
    delivered.ids.join() === 'msg-1,evt-1' &&
    delivered.campaign === 'order_confirmed_en' &&
    delivered.mobile === '919876543210' &&
    delivered.at.getTime() === 1794465100000,
);
const failedEvt = parseAisensyNotification(
  { topic: 'message.status.updated', data: { message: { messageId: 'm2', phone_number: '919876543210', status: 'failed', failureResponse: { code: 131026, reason: 'Message undeliverable' } } } },
  now,
);
ok('status: failed with reason', failedEvt.kind === 'status' && failedEvt.status === 'failed' && failedEvt.error === 'AiSensy: Message undeliverable');
const readByTopic = parseAisensyNotification({ topic: 'contact.campaign.read', data: { message: { phone_number: '919876543210' } } }, now);
ok('status taken from the topic when the message has none', readByTopic.kind === 'status' && readByTopic.status === 'read');
const queued = parseAisensyNotification({ topic: 'message.status.updated', data: { message: { phone_number: '919876543210', status: 'ENQUEUED' } } }, now);
ok('untracked status ignored', queued.kind === 'ignored');
const stop = parseAisensyNotification(
  { id: 'n3', topic: 'message.sender.user', data: { message: { messageId: 'in-1', phone_number: '919876543210', message_type: 'TEXT', message_content: { text: 'STOP' }, sent_at: 1794465200000 } } },
  now,
);
ok('inbound text', stop.kind === 'inbound' && stop.input.text === 'STOP' && stop.input.type === 'text' && stop.input.providerMessageId === 'in-1');
eq('STOP intent', intentOf(stop.kind === 'inbound' ? stop.input.text : ''), 'STOP');
const button = parseAisensyNotification(
  { topic: 'message.sender.user', data: { message: { id: 'in-2', phone_number: '919876543210', message_type: 'BUTTON', message_content: { button: { text: 'Report a problem', payload: 'REPORT_ISSUE' } } } } },
  now,
);
ok('inbound button payload', button.kind === 'inbound' && button.input.payload === 'REPORT_ISSUE' && button.input.type === 'button');
eq('quick-reply text understood', intentOf('Report a problem'), 'REPORT_ISSUE');
eq('quick-reply text understood (talk)', intentOf('talk to us'), 'TALK');
eq('ordinary text is not an intent', intentOf('Thanks, milk was great'), null);
const loc = parseAisensyNotification(
  { topic: 'message.sender.user', data: { message: { id: 'in-3', phone_number: '919876543210', message_type: 'LOCATION', message_content: { location: { latitude: 17.47, longitude: 78.54 } } } } },
  now,
);
ok('inbound location', loc.kind === 'inbound' && loc.input.type === 'location' && loc.input.location?.lat === 17.47);
ok('no message → ignored', parseAisensyNotification({ topic: 'message.status.updated', data: {} }, now).kind === 'ignored');
ok('other topic → ignored', parseAisensyNotification({ topic: 'contact.created', data: { message: { phone_number: '91' } } }, now).kind === 'ignored');
ok('garbage → ignored, never throws', parseAisensyNotification('nonsense', now).kind === 'ignored' && parseAisensyNotification(null, now).kind === 'ignored');
eq('ms timestamp', toDate(1794465000000, now).getTime(), 1794465000000);
eq('s timestamp', toDate('1794465000', now).getTime(), 1794465000000);
eq('bad timestamp → fallback', toDate('soon', now).getTime(), now.getTime());

for (const [k, v] of Object.entries(saved)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
console.log(`\naisensy: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL', f);
process.exit(fails.length ? 1 : 0);
