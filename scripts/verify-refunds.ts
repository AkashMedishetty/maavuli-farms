/**
 * Pure tests for the published cancellation formula (lib/refunds.computeCancellationRefund)
 * and the credit-ledger fold (lib/credits.foldBalance). No database.
 *   pnpm test:refunds
 */

import assert from 'node:assert/strict';
import { computeCancellationRefund, sourceSplit, standardDailyPaise, isValidUpiId } from '../lib/refunds.ts';
import { foldBalance } from '../lib/credits.ts';
import { quote } from '../lib/pricing.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const cowYear = quote('cow', 'one', '1y');
const cowDaily = standardDailyPaise('cow', 1, 1);

t('the plan in the policy example costs ₹35,190 and the standard daily is ₹115', () => {
  assert.equal(cowYear.finalPaise, 3_519_000);
  assert.equal(cowDaily, 11_500);
  assert.equal(standardDailyPaise('buffalo', 1, 2), 4_750);
});

t('policy example: 60 charged days → ₹6,900 charged, ₹28,290 refunded', () => {
  const b = computeCancellationRefund({ planPaise: 3_519_000, creditAppliedPaise: 0, chargedDays: 60, standardDailyPaise: cowDaily, refundableCreditPaise: 0 });
  assert.equal(b.chargedPaise, 690_000);
  assert.equal(b.balancePaise, 2_829_000);
  assert.equal(b.toSourcePaise, 2_829_000);
  assert.equal(b.toCreditPaise, 0);
});

t('the refund reaches ₹0 at day 306 and is positive at day 305', () => {
  const at = (d: number) => computeCancellationRefund({ planPaise: 3_519_000, creditAppliedPaise: 0, chargedDays: d, standardDailyPaise: cowDaily, refundableCreditPaise: 0 });
  assert.equal(at(306).balancePaise, 0);
  assert.equal(at(306).toSourcePaise, 0);
  assert.equal(at(305).balancePaise, 11_500);
});

t('never negative, even far past the break-even day or with junk input', () => {
  const b = computeCancellationRefund({ planPaise: 3_519_000, creditAppliedPaise: 0, chargedDays: 360, standardDailyPaise: cowDaily, refundableCreditPaise: 0 });
  assert.equal(b.balancePaise, 0);
  assert.equal(b.toSourcePaise, 0);
  assert.equal(b.toCreditPaise, 0);
  const j = computeCancellationRefund({ planPaise: -5, creditAppliedPaise: -1, chargedDays: -3, standardDailyPaise: Number.NaN, refundableCreditPaise: -9 });
  for (const v of Object.values(j)) assert.ok(v >= 0);
});

t('credit applied at checkout goes back to credit, never to the card', () => {
  const b = computeCancellationRefund({ planPaise: 3_519_000, creditAppliedPaise: 1_000_000, chargedDays: 60, standardDailyPaise: cowDaily, refundableCreditPaise: 0 });
  assert.equal(b.toSourcePaise, 2_519_000); // capped at what the card actually paid
  assert.equal(b.toCreditPaise, 310_000);
  assert.equal(b.toSourcePaise + b.toCreditPaise, b.balancePaise);
  const s = sourceSplit(b);
  assert.deepEqual(s, { fromBalance: 2_519_000, fromCredit: 0, balanceToCredit: 310_000 });
});

t('a fully credit-paid plan refunds nothing to source', () => {
  const b = computeCancellationRefund({ planPaise: 345_000, creditAppliedPaise: 345_000, chargedDays: 10, standardDailyPaise: cowDaily, refundableCreditPaise: 0 });
  assert.equal(b.toSourcePaise, 0);
  assert.equal(b.toCreditPaise, 230_000);
});

t('unspent refundable missed-day credit is added to the refund', () => {
  const b = computeCancellationRefund({ planPaise: 3_519_000, creditAppliedPaise: 0, chargedDays: 60, standardDailyPaise: cowDaily, refundableCreditPaise: 21_850 });
  assert.equal(b.toSourcePaise, 2_829_000 + 21_850);
  assert.deepEqual(sourceSplit(b), { fromBalance: 2_829_000, fromCredit: 21_850, balanceToCredit: 0 });
});

t('refundable credit beyond the card cap stays as credit (not double-counted)', () => {
  // past break-even: balance 0, only missed-day credit remains
  const b = computeCancellationRefund({ planPaise: 3_519_000, creditAppliedPaise: 3_500_000, chargedDays: 320, standardDailyPaise: cowDaily, refundableCreditPaise: 50_000 });
  assert.equal(b.balancePaise, 0);
  assert.equal(b.toSourcePaise, 19_000);
  assert.equal(b.toCreditPaise, 31_000);
  assert.deepEqual(sourceSplit(b), { fromBalance: 0, fromCredit: 19_000, balanceToCredit: 0 });
});

t('ledger fold: balance, refundable in/out, capped by balance', () => {
  const rows = [
    { amountPaise: 11_500, kind: 'missed_delivery' as const, refundable: true },
    { amountPaise: 20_000, kind: 'goodwill' as const, refundable: false },
    { amountPaise: -5_000, kind: 'refund_payout' as const, refundable: false },
  ];
  assert.deepEqual(foldBalance(rows), { balancePaise: 26_500, refundablePaise: 6_500 });
  // spending most of the balance on an extra caps refundable at what is left
  assert.deepEqual(foldBalance([...rows, { amountPaise: -24_000, kind: 'extra_spend' as const, refundable: false }]), {
    balancePaise: 2_500,
    refundablePaise: 2_500,
  });
});

t('UPI id validation', () => {
  for (const ok of ['ravi@okaxis', 'ravi.k-1@ybl', '9876543210@paytm']) assert.ok(isValidUpiId(ok), ok);
  for (const bad of ['', 'ravi', '@okaxis', 'ravi@', 'ra vi@ok', 'ravi@1bank']) assert.ok(!isValidUpiId(bad), bad);
});

console.log(`\n${passed} passed`);
