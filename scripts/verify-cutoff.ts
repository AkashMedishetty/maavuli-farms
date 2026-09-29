// Unit tests for lib/cutoff.ts — pure, no DB. Run: pnpm test:cutoff
import {
  addDaysYMD,
  closeInstant,
  daysBetween,
  DEFAULT_DAY_RULES as R,
  firstOpenDate,
  hmLabel,
  isPastCutoff,
  istInstant,
  istMinutes,
  istYMD,
  isYMD,
  lockInstant,
  validateDayRules,
  windowInstants,
} from '../lib/cutoff.ts';

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

// --- wall time <-> instant ---
eq('istInstant 16:00 IST is 10:30Z', istInstant('2026-10-01', '16:00').toISOString(), '2026-10-01T10:30:00.000Z');
eq('istInstant midnight IST is previous-day 18:30Z', istInstant('2026-10-01', '00:00').toISOString(), '2026-09-30T18:30:00.000Z');
eq('istYMD after 18:30Z rolls to next day', istYMD(new Date('2026-09-29T18:40:00Z')), '2026-09-30');
eq('istYMD before 18:30Z stays', istYMD(new Date('2026-09-29T18:20:00Z')), '2026-09-29');
eq('istMinutes 16:00', istMinutes(istInstant('2026-10-01', '16:00')), 960);
for (const d of ['2026-01-01', '2026-02-28', '2028-02-29', '2026-12-31']) {
  eq(`round trip ${d}`, istYMD(istInstant(d, '00:00')), d);
  eq(`round trip ${d} 23:59`, istYMD(istInstant(d, '23:59')), d);
}

// --- calendar ---
eq('addDays month end', addDaysYMD('2026-01-31', 1), '2026-02-01');
eq('addDays year end', addDaysYMD('2026-12-31', 1), '2027-01-01');
eq('addDays leap', addDaysYMD('2028-02-28', 1), '2028-02-29');
eq('addDays negative', addDaysYMD('2026-03-01', -1), '2026-02-28');
eq('daysBetween', daysBetween('2026-09-29', '2026-10-02'), 3);
eq('isYMD rejects 2026-02-30', isYMD('2026-02-30'), false);
eq('isYMD accepts 2026-02-28', isYMD('2026-02-28'), true);

// --- cutoff ---
eq('lockInstant is cutoff on the day before', lockInstant('2026-10-02', R).toISOString(), '2026-10-01T10:30:00.000Z');
const before4 = istInstant('2026-10-01', '15:59');
const at4 = istInstant('2026-10-01', '16:00');
const after4 = istInstant('2026-10-01', '21:00');
const earlyMorning = istInstant('2026-10-01', '00:30');
eq('before 4 PM: tomorrow is open', firstOpenDate(before4, R), '2026-10-02');
eq('at 4 PM: tomorrow closes, day after is first open', firstOpenDate(at4, R), '2026-10-03');
eq('evening: day after tomorrow', firstOpenDate(after4, R), '2026-10-03');
eq('00:30: today is past cutoff, tomorrow open', firstOpenDate(earlyMorning, R), '2026-10-02');
eq('isPastCutoff today always', isPastCutoff('2026-10-01', earlyMorning, R), true);
eq('isPastCutoff tomorrow before 4', isPastCutoff('2026-10-02', before4, R), false);
eq('isPastCutoff tomorrow at 4', isPastCutoff('2026-10-02', at4, R), true);

// matches the legacy pause rule (hour < 16 ? +1 : +2) for every hour of a day
for (let h = 0; h < 24; h++) {
  const hm = `${String(h).padStart(2, '0')}:10`;
  const now = istInstant('2026-10-01', hm);
  const legacy = addDaysYMD('2026-10-01', h < 16 ? 1 : 2);
  eq(`legacy parity ${hm}`, firstOpenDate(now, R), legacy);
}

// a different cutoff
const late = { ...R, cutoffTime: '21:30' };
eq('21:30 cutoff at 21:00 keeps tomorrow open', firstOpenDate(after4, late), '2026-10-02');

// --- day close / window ---
eq('closeInstant 10:00 IST', closeInstant('2026-10-02', R).toISOString(), '2026-10-02T04:30:00.000Z');
eq('window start', windowInstants('2026-10-02', R).start.toISOString(), '2026-10-02T00:00:00.000Z');
eq('hmLabel 16:00', hmLabel('16:00'), '4:00 PM');
eq('hmLabel 05:30', hmLabel('05:30'), '5:30 AM');
eq('hmLabel 00:15', hmLabel('00:15'), '12:15 AM');
eq('hmLabel 12:00', hmLabel('12:00'), '12:00 PM');

// --- validation ---
eq('defaults valid', validateDayRules(R), []);
eq('bad format', validateDayRules({ ...R, cutoffTime: '4pm' }).length, 1);
eq('window inverted', validateDayRules({ ...R, windowStart: '09:00', windowEnd: '08:00' }).length > 0, true);
eq('close before window end', validateDayRules({ ...R, dayCloseTime: '07:00' }).length > 0, true);

console.log(`cutoff: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
