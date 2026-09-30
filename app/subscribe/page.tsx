import NavPanel from '@/components/NavPanel';
import { hmLabel } from '@/lib/cutoff';
import { dayRulesForDisplay } from '@/lib/settings';
import SubscribeFlow from './SubscribeFlow';
import { loadRenewal } from './renewal';
import type { DayRuleLabels } from './types';
import './subscribe.css';

/**
 * /subscribe — server component. It resolves the renewal context
 * (`?renew=<subscriptionId>`, the signed-in customer's own plan) and the live
 * delivery window / cut-off (ops can change them in admin), and hands plain JSON to
 * the client flow; everything interactive lives in SubscribeFlow.
 */
export const dynamic = 'force-dynamic';

export default async function SubscribePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const renewRaw = typeof sp.renew === 'string' ? sp.renew.trim() : undefined;
  const [renewal, dayRules] = await Promise.all([loadRenewal(renewRaw || undefined), dayRulesForDisplay()]);
  const rules: DayRuleLabels = {
    cutoff: hmLabel(dayRules.cutoffTime),
    windowStart: hmLabel(dayRules.windowStart),
    windowEnd: hmLabel(dayRules.windowEnd),
  };
  return (
    <>
      <NavPanel />
      {/* keyed on the renewal state: signing in at the renewal gate refreshes the page,
          and the flow must start again from the plan that sign-in unlocked */}
      <SubscribeFlow key={renewal.kind} renewal={renewal} rules={rules} />
    </>
  );
}
