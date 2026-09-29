// Unit tests for lib/transitions.ts — pure. Run: pnpm test:transitions
import {
  assertTransition,
  canTransition,
  DELIVERY_TRANSITIONS,
  IllegalTransitionError,
  isTerminal,
  ORDER_TRANSITIONS,
  REFUND_TRANSITIONS,
  RUN_TRANSITIONS,
  SUB_TRANSITIONS,
} from '../lib/transitions.ts';

let passed = 0;
let failed = 0;
function t(name: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}

// every target state is itself a key (no typos that create phantom states)
for (const [name, table] of Object.entries({
  ORDER_TRANSITIONS,
  SUB_TRANSITIONS,
  DELIVERY_TRANSITIONS,
  RUN_TRANSITIONS,
  REFUND_TRANSITIONS,
})) {
  const keys = new Set(Object.keys(table));
  for (const [from, tos] of Object.entries(table as Record<string, readonly string[]>)) {
    for (const to of tos) t(`${name} ${from}→${to} target exists`, keys.has(to));
    t(`${name} ${from} has no self-loop`, !tos.includes(from));
  }
}

t('order paid is not re-payable', !canTransition(ORDER_TRANSITIONS, 'paid', 'paid'));
t('late payment on expired order activates', canTransition(ORDER_TRANSITIONS, 'expired', 'paid'));
t('refunded is terminal', isTerminal(ORDER_TRANSITIONS, 'refunded'));
t('cancelled subscription is terminal', isTerminal(SUB_TRANSITIONS, 'cancelled'));
t('completed subscription cannot be cancelled', !canTransition(SUB_TRANSITIONS, 'completed', 'cancelled'));
t('planned delivery cannot jump to delivered', !canTransition(DELIVERY_TRANSITIONS, 'planned', 'delivered'));
t('unconfirmed can be resolved delivered', canTransition(DELIVERY_TRANSITIONS, 'unconfirmed', 'delivered'));
t('cancelled delivery is terminal', isTerminal(DELIVERY_TRANSITIONS, 'cancelled'));
t('closed run is terminal', isTerminal(RUN_TRANSITIONS, 'closed'));
t('processed refund is terminal', isTerminal(REFUND_TRANSITIONS, 'processed'));
t('awaiting_upi only goes to paid_manually', REFUND_TRANSITIONS.awaiting_upi.join() === 'paid_manually');

let threw = false;
try {
  assertTransition('delivery', DELIVERY_TRANSITIONS, 'planned', 'delivered');
} catch (e) {
  threw = e instanceof IllegalTransitionError && e.from === 'planned' && e.to === 'delivered';
}
t('assertTransition throws IllegalTransitionError', threw);

console.log(`transitions: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
