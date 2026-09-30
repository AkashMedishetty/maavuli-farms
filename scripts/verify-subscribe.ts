/**
 * Unit checks for the subscribe flow's pure helpers: the tab draft (app/subscribe/draft.ts)
 * and screen routing / formatting (app/subscribe/lib.ts).
 * Run: ./node_modules/.bin/tsx scripts/verify-subscribe.ts
 */
import { DRAFT_MAX_AGE_MS, parseDraft, serializeDraft, type Draft } from '../app/subscribe/draft';
import { EMPTY_ADDRESS, formatMobile, isFlowStep, isOutsideZone, stepForFail } from '../app/subscribe/lib';
import type { ApiFail } from '../app/subscribe/types';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const NOW = Date.UTC(2026, 8, 30, 6, 0, 0);
const full: Draft = {
  step: 'pay',
  pin: { lat: 17.4741, lng: 78.5475, accuracyM: 12, label: 'Sai Residency, Safilguda' },
  addr: { ...EMPTY_ADDRESS, name: 'Anitha Rao', house: '203', society: 'Sai Residency' },
  milk: 'buffalo',
  qty: 'one',
  term: '3m',
  start: { mode: 'earliest', date: '' },
  reachedPay: true,
  payKey: { sig: '{"a":1}', key: 'abcdef0123456789' },
};
const raw = (over: Record<string, unknown> = {}, savedAt = NOW) =>
  JSON.stringify({ ...JSON.parse(serializeDraft(full, savedAt)), ...over });

/* ---- draft: round trip ---- */
{
  const d = parseDraft(serializeDraft(full, NOW), NOW + 1000);
  ok('round trip keeps every field', JSON.stringify(d) === JSON.stringify(full), JSON.stringify(d));
}

/* ---- draft: refuses what it cannot trust ---- */
ok('null / empty', parseDraft(null, NOW) === null && parseDraft('', NOW) === null);
ok('not JSON', parseDraft('{not json', NOW) === null);
ok('array', parseDraft('[]', NOW) === null);
ok('wrong version', parseDraft(raw({ v: 2 }), NOW) === null);
ok('missing savedAt', parseDraft(raw({ savedAt: 'yesterday' }), NOW) === null);
ok('older than 24 h', parseDraft(serializeDraft(full, NOW - DRAFT_MAX_AGE_MS - 1), NOW) === null);
ok('from the future', parseDraft(serializeDraft(full, NOW + 5 * 60_000), NOW) === null);
ok('just under 24 h is kept', parseDraft(serializeDraft(full, NOW - DRAFT_MAX_AGE_MS + 1000), NOW) !== null);

/* ---- draft: field-level cleanup ---- */
{
  const d = parseDraft(raw({ milk: 'goat', qty: 'three', term: '5y' }), NOW);
  ok('unknown plan ids become null', d !== null && d.milk === null && d.qty === null && d.term === null);
  ok('…and a pay step with no plan drops back to plan', d?.step === 'plan', String(d?.step));
}
{
  const d = parseDraft(raw({ pin: { lat: 123, lng: 78 } }), NOW);
  ok('an impossible pin is dropped', d !== null && d.pin === null);
  ok('…and with no pin the flow restarts at the map', d?.step === 'where', String(d?.step));
}
{
  const d = parseDraft(raw({ pin: { lat: '17.4', lng: 78.5 } }), NOW);
  ok('a string latitude is refused', d?.pin === null);
}
{
  const d = parseDraft(raw({ pin: { lat: 17.4, lng: 78.5, accuracyM: -3, label: 42 } }), NOW);
  ok('bad accuracy / label are dropped, the pin kept', d?.pin?.lat === 17.4 && d.pin.accuracyM === undefined && d.pin.label === undefined);
}
{
  const d = parseDraft(raw({ step: 'admin' }), NOW);
  ok('an unknown step becomes where', d?.step === 'where', String(d?.step));
}
{
  const d = parseDraft(raw({ addr: { name: 'x'.repeat(500), house: 7, pincode: '5000470000', evil: '<script>' } }), NOW);
  ok('address fields are truncated to their limits', d?.addr.name.length === 100 && d.addr.pincode === '500047');
  ok('non-string address fields become empty', d?.addr.house === '');
  ok('unknown address keys are ignored', d !== null && !('evil' in d.addr));
}
{
  const d = parseDraft(raw({ start: { mode: 'later', date: '2026-10-05' } }), NOW);
  ok('a later start is kept', d?.start.mode === 'later' && d.start.date === '2026-10-05');
  const bad = parseDraft(raw({ start: { mode: 'later', date: 'tomorrow' } }), NOW);
  ok('a later start without a real date falls back to earliest', bad?.start.mode === 'earliest' && bad.start.date === '');
}
{
  const d = parseDraft(raw({ payKey: { sig: 's', key: 'short' } }), NOW);
  ok('a too-short idempotency key is dropped', d?.payKey === null);
  const e = parseDraft(raw({ reachedPay: 'yes' }), NOW);
  ok('reachedPay must be a real boolean', e?.reachedPay === false);
}

/* ---- screen routing for API failures ---- */
const fail = (over: Partial<ApiFail>): ApiFail => ({ status: 400, error: '', issues: [], ...over });
ok('outside_zone → where', stepForFail(fail({ code: 'outside_zone' })) === 'where');
ok('details_incomplete → where', stepForFail(fail({ code: 'details_incomplete' })) === 'where');
ok('date_locked → plan', stepForFail(fail({ code: 'date_locked', status: 409 })) === 'plan');
ok('start_invalid → plan', stepForFail(fail({ code: 'start_invalid' })) === 'plan');
ok('plan_invalid → plan', stepForFail(fail({ code: 'plan_invalid' })) === 'plan');
ok('not_renewable → pay', stepForFail(fail({ code: 'not_renewable', status: 409 })) === 'pay');
ok('uncoded address text → where', stepForFail(fail({ error: 'Please add the delivery address' })) === 'where');
ok('uncoded start text → plan', stepForFail(fail({ error: 'The first delivery can be at most 30 days away' })) === 'plan');
ok('a 500 stays on pay', stepForFail(fail({ status: 500, error: 'Something went wrong on our side' })) === 'pay');
ok('a network failure stays on pay', stepForFail(fail({ status: 0, error: 'Could not reach our server' })) === 'pay');
ok('isOutsideZone by code', isOutsideZone(fail({ code: 'outside_zone' })));
ok('isOutsideZone by text', isOutsideZone(fail({ error: 'That pin is outside our delivery area' })));
ok('isOutsideZone not for other 400s', !isOutsideZone(fail({ error: 'Pick a date' })));
ok('isFlowStep', isFlowStep('where') && isFlowStep('plan') && isFlowStep('pay') && !isFlowStep('review') && !isFlowStep(undefined));

/* ---- mobile formatting ---- */
ok('10 digits', formatMobile('9800000101') === '+91 98000 00101');
ok('already prefixed', formatMobile('+91 98000 00101') === '+91 98000 00101');
ok('91 + 10 digits', formatMobile('919800000101') === '+91 98000 00101');
ok('not a mobile stays as is', formatMobile('12345') === '12345');

console.log(`subscribe: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
