/**
 * Unit checks for the rider app's pure helpers (components/rider/logic.ts).
 * Run: ./node_modules/.bin/tsx scripts/verify-rider-ui.ts
 */
import {
  applyOptimisticOutcome,
  classifyResult,
  formatLitres,
  formatRoundDate,
  istDate,
  rejectionMessage,
  stopProgress,
  usableCachedRound,
} from '../components/rider/logic';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  }
}

/* UI-13: progress per stop, not per item */
const mk = () => ({
  stops: [
    {
      stopKey: 's1',
      done: false,
      items: [
        { deliveryId: 'd1', status: 'out_for_delivery' },
        { deliveryId: 'd2', status: 'out_for_delivery' },
      ],
    },
    { stopKey: 's2', done: false, items: [{ deliveryId: 'd3', status: 'out_for_delivery' }] },
  ],
  progress: { total: 2, done: 0 },
});
{
  let t = mk();
  t = applyOptimisticOutcome(t, 'd1', 'delivered');
  t = applyOptimisticOutcome(t, 'd2', 'delivered');
  check('two items of one stop count as one stop', t.progress.done === 1, t.progress);
  check('total unchanged', t.progress.total === 2, t.progress);
  check('stop 1 marked done', !!t.stops[0]?.done && !!t.stops[0]?.items.every(i => i.status === 'delivered'));
  check('stop 2 untouched', t.stops[1]?.done === false);
  check('end-run not offered while a stop is open', t.progress.done !== t.progress.total);
  t = applyOptimisticOutcome(t, 'd3', 'not_delivered');
  check('all stops done', t.progress.done === 2 && t.progress.total === 2, t.progress);
  check('unknown delivery changes nothing', applyOptimisticOutcome(mk(), 'zz', 'delivered').progress.done === 0);
  check('stopProgress', JSON.stringify(stopProgress([{ done: true }, { done: false }, { done: true }])) === '{"total":3,"done":2}');
  check('input not mutated', mk().stops[0]?.done === false);
}

/* UI-15: result classification + rejection message */
check('ok → ok', classifyResult({ ok: true }) === 'ok');
check('duplicate → ok', classifyResult({ ok: true, duplicate: true }) === 'ok');
check('retryable → retry', classifyResult({ ok: false, retryable: true, error: 'photo not uploaded' }) === 'retry');
check('no retryable → rejected', classifyResult({ ok: false, error: 'not your delivery' }) === 'rejected');
check('retryable:false → rejected', classifyResult({ ok: false, retryable: false }) === 'rejected');
check('missing result → retry', classifyResult(undefined) === 'retry');
{
  const stops = mk().stops;
  const pastDay = "Only today's stops can be changed from the app. Ask ops to correct an earlier day.";
  const m1 = rejectionMessage(
    [
      { actionId: 'a1', deliveryId: 'd1', error: pastDay },
      { actionId: 'a2', deliveryId: 'd2', error: pastDay },
    ],
    stops,
  );
  check('two items same stop → "1 stop"', m1 === `1 stop was not saved: ${pastDay}`, m1);
  const m2 = rejectionMessage(
    [
      { actionId: 'a1', deliveryId: 'd1', error: 'not your delivery' },
      { actionId: 'a3', deliveryId: 'd3', error: 'illegal transition' },
    ],
    stops,
  );
  check('two stops', m2 === '2 stops were not saved: not your delivery · illegal transition', m2);
  check('unknown delivery still counted', rejectionMessage([{ actionId: 'x', deliveryId: 'q', error: '' }], stops) === '1 stop was not saved.');
  check('none → null', rejectionMessage([], stops) === null);
}

/* UI-16: cached round only when it is today's IST date */
{
  // 2026-09-28T19:00Z = 2026-09-29 00:30 IST
  const lateUtc = new Date('2026-09-28T19:00:00Z');
  check('istDate crosses midnight IST', istDate(lateUtc) === '2026-09-29', istDate(lateUtc));
  check('istDate same day', istDate(new Date('2026-09-29T11:39:00Z')) === '2026-09-29');
  check('istDate before IST midnight', istDate(new Date('2026-09-28T18:29:00Z')) === '2026-09-28');
  const cached = { date: '2026-09-29', stops: [] };
  check('today cache used', usableCachedRound(cached, lateUtc) === cached);
  check('yesterday cache refused', usableCachedRound({ date: '2026-09-28' }, lateUtc) === null);
  check('null cache', usableCachedRound(null, lateUtc) === null);
  check('cache without date refused', usableCachedRound({} as { date?: string }, lateUtc) === null);
}

/* UI-18: date label + litre rounding */
check('date label', formatRoundDate('2026-09-29') === 'Tue 29 Sep', formatRoundDate('2026-09-29'));
check('date label single-digit day', formatRoundDate('2026-10-04') === 'Sun 4 Oct', formatRoundDate('2026-10-04'));
check('date label garbage passthrough', formatRoundDate('soon') === 'soon');
check('litres float noise', formatLitres(4.199999) === '4.2', formatLitres(4.199999));
check('litres 0.1+0.2', formatLitres(0.1 + 0.2) === '0.3', formatLitres(0.1 + 0.2));
check('litres integer', formatLitres(5) === '5');
check('litres half', formatLitres(1.5) === '1.5');
check('litres NaN', formatLitres(Number.NaN) === '0');

console.log(`verify-rider-ui: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
