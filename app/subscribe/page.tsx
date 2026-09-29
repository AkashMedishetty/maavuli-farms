import NavPanel from '@/components/NavPanel';
import SubscribeFlow from './SubscribeFlow';
import { loadRenewal } from './renewal';
import './subscribe.css';

/**
 * /subscribe — server component. It only resolves the renewal context
 * (`?renew=<subscriptionId>`, the signed-in customer's own plan) and hands plain
 * JSON to the client flow; everything interactive lives in SubscribeFlow.
 */
export const dynamic = 'force-dynamic';

export default async function SubscribePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const renewRaw = typeof sp.renew === 'string' ? sp.renew.trim() : undefined;
  const renewal = await loadRenewal(renewRaw || undefined);
  return (
    <>
      <NavPanel />
      <SubscribeFlow renewal={renewal} />
    </>
  );
}
