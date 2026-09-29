// Unit tests for lib/rider-pure.ts — pure, no DB. Run: pnpm test:rider
import {
  backoffMs,
  deliveredProofOk,
  distanceFromPinM,
  isDeliveryFlagged,
  mergeQueue,
  resolveFault,
  validateAction,
  type QueueRow,
} from '../lib/rider-pure.ts';

let passed = 0;
let failed = 0;
function t(name: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}

// ---- distance from pin ----
const pin = { lat: 17.385, lng: 78.4867 }; // Hyderabad
t('distance null without pin', distanceFromPinM(undefined, { lat: 17.385, lng: 78.4867 }) === null);
t('distance null without tap', distanceFromPinM(pin, {}) === null);
t('distance ~0 at the pin', distanceFromPinM(pin, { lat: 17.385, lng: 78.4867 }) === 0);
{
  // ~0.001 deg lat ≈ 111 m
  const d = distanceFromPinM(pin, { lat: 17.386, lng: 78.4867 });
  t('distance ~111m one milli-degree north', d !== null && d > 100 && d < 120);
}

// ---- flag decision ----
t('flag when no photo', isDeliveryFlagged({ hasPhoto: false, distanceM: 5, flagThresholdM: 150 }) === true);
t('flag when far from pin', isDeliveryFlagged({ hasPhoto: true, distanceM: 300, flagThresholdM: 150 }) === true);
t('no flag when close with photo', isDeliveryFlagged({ hasPhoto: true, distanceM: 40, flagThresholdM: 150 }) === false);
t('no flag when distance unknown but photo present', isDeliveryFlagged({ hasPhoto: true, distanceM: null, flagThresholdM: 150 }) === false);

// ---- proof ok ----
t('proof ok with photo', deliveredProofOk(true, undefined) === true);
t('proof ok with note only', deliveredProofOk(false, 'left with guard') === true);
t('proof NOT ok without either', deliveredProofOk(false, '   ') === false);

// ---- fault mapping ----
t('no_access → customer', resolveFault('no_access', 'rider') === 'customer');
t('out_of_stock → ours', resolveFault('out_of_stock', 'rider') === 'ours');
t('could_not_find → unknown', resolveFault('could_not_find', 'rider') === 'unknown');
t('rider cannot override fault', resolveFault('could_not_find', 'rider', 'ours') === 'unknown');
t('staff CAN override fault', resolveFault('could_not_find', 'staff', 'ours') === 'ours');
t('staff without explicit takes default', resolveFault('refused', 'staff') === 'customer');
t('system (platform rule) CAN set fault', resolveFault('other', 'system', 'ours') === 'ours');
t('customer cannot override fault', resolveFault('could_not_find', 'customer', 'ours') === 'unknown');

// ---- action validation ----
t('delivered with photo valid', validateAction({ type: 'delivered', deliveryId: 'x', hasPhoto: true }).ok === true);
t('delivered with note valid', validateAction({ type: 'delivered', deliveryId: 'x', note: 'guard' }).ok === true);
t('delivered without proof invalid', validateAction({ type: 'delivered', deliveryId: 'x' }).ok === false);
t('not_delivered needs reason', validateAction({ type: 'not_delivered', deliveryId: 'x' }).ok === false);
t('not_delivered valid reason', validateAction({ type: 'not_delivered', deliveryId: 'x', reason: 'refused' }).ok === true);
t('not_delivered bad reason', validateAction({ type: 'not_delivered', deliveryId: 'x', reason: 'nope' }).ok === false);
t('missing deliveryId invalid', validateAction({ type: 'delivered', hasPhoto: true }).ok === false);
t('unknown type invalid', validateAction({ type: 'x', deliveryId: 'x' }).ok === false);

// ---- queue merge (replay of same actionId replaces, does not duplicate) ----
{
  const a: QueueRow = { actionId: 'a1', attempts: 0, nextAttemptAt: 0, createdAt: 10 };
  const b: QueueRow = { actionId: 'a2', attempts: 0, nextAttemptAt: 0, createdAt: 20 };
  const a2: QueueRow = { actionId: 'a1', attempts: 3, nextAttemptAt: 999, createdAt: 10 };
  const merged = mergeQueue([a, b], [a2]);
  t('merge dedupes by actionId', merged.length === 2);
  t('merge keeps latest row for actionId', merged.find(r => r.actionId === 'a1')!.attempts === 3);
  t('merge sorted by createdAt', merged[0]!.actionId === 'a1' && merged[1]!.actionId === 'a2');
}

// ---- backoff ----
t('backoff grows', backoffMs(0) === 1000 && backoffMs(1) === 2000 && backoffMs(3) === 8000);
t('backoff capped at 60s', backoffMs(20) === 60_000);

console.log(`rider: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
