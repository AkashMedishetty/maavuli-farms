/**
 * Verifies the pricing engine against the client's own matrix.
 *
 * EXPECT rows are the client's figures that already reconcile — the engine must
 * reproduce all of them exactly. CORRECTED rows are the seven cells that did not
 * reconcile; the engine's value is the right one and this script prints both so
 * the difference is auditable rather than silently "fixed".
 *
 * Run: pnpm test:pricing
 */
import { quote, formatINR, type MilkKind } from '../lib/pricing.ts';

type Row = [MilkKind, string, string, number, number, number, number];
//          kind      qty     tenure  original  final    saving  perLitre   (all in rupees)

const EXPECT: Row[] = [
  // buffalo — the client's whole buffalo matrix reconciles
  ['buffalo', 'one',  '1m',  2850,   2850,      0,      95.00],
  ['buffalo', 'one',  '3m',  8550,   8122.50,   427.50,  90.25],
  ['buffalo', 'one',  '6m', 17100,  15390,     1710,     85.50],
  ['buffalo', 'one',  '1y', 34200,  29070,     5130,     80.75],
  ['buffalo', 'half', '1m',  1425,   1425,        0,     95.00],
  ['buffalo', 'half', '3m',  4275,   4061.25,   213.75,  90.25],
  ['buffalo', 'half', '6m',  8550,   7695,      855,     85.50],
  ['buffalo', 'half', '1y', 17100,  14535,     2565,     80.75],
  // cow — only the rows the client had right
  ['cow',     'one',  '1m',  3450,   3450,        0,    115.00],
  ['cow',     'one',  '6m', 20700,  18630,     2070,    103.50],
  ['cow',     'half', '1m',  1725,   1725,        0,    115.00],
  ['cow',     'half', '6m', 10350,   9315,     1035,    103.50],
];

/** cell -> [what the client's table said, why it was wrong] */
const CORRECTED: Record<string, [string, string]> = {
  'cow/one/3m/final':      ['₹9,817.50',  'a 5.145% cut, not the stated 5%'],
  'cow/half/3m/final':     ['₹4,908.75',  'same error, halved'],
  'cow/one/1y/original':   ['₹40,500',    '115 x 360 = 41,400'],
  'cow/half/1y/original':  ['₹20,250',    'same error, halved'],
  'cow/one/1y/saving':     ['₹5,130',     "the buffalo row's saving, copy-pasted"],
  'cow/half/1y/saving':    ['₹2,655',     'follows from the wrong original'],
};

const P = (rupees: number) => Math.round(rupees * 100);
let failures = 0;

for (const [kind, qty, ten, original, final, saving, perLitre] of EXPECT) {
  const q = quote(kind, qty, ten);
  const checks: [string, number, number][] = [
    ['original', q.originalPaise, P(original)],
    ['final',    q.finalPaise,    P(final)],
    ['saving',   q.savingPaise,   P(saving)],
    ['perLitre', q.perLitrePaise, P(perLitre)],
  ];
  for (const [field, got, want] of checks) {
    if (got !== want) {
      failures++;
      console.error(
        `FAIL ${kind}/${qty}/${ten} ${field}: got ${formatINR(got)} want ${formatINR(want)}`
      );
    }
  }
}

console.log(
  failures === 0
    ? `✓ ${EXPECT.length} client rows reproduced exactly (${EXPECT.length * 4} assertions)`
    : `✗ ${failures} mismatch(es)`
);

console.log('\nCells the client\'s table had wrong — engine value vs theirs:');
const FIELD = { final: 'finalPaise', original: 'originalPaise', saving: 'savingPaise' } as const;
for (const [key, [theirs, why]] of Object.entries(CORRECTED)) {
  const [kind, qty, ten, field] = key.split('/') as [MilkKind, string, string, keyof typeof FIELD];
  const q = quote(kind, qty, ten);
  const ours = formatINR(q[FIELD[field]]);
  console.log(`  ${kind}/${qty}/${ten} ${field.padEnd(9)} ${ours.padStart(11)}  (theirs ${theirs} — ${why})`);
}

process.exit(failures === 0 ? 0 : 1);
