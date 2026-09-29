import { formatINR } from '@/lib/pricing';
import type { RefundBreakdown } from '@/lib/models';

/**
 * The cancellation-policy breakdown, line by line. Pure presentational (no hooks),
 * usable from server pages and client components alike.
 */
export default function Breakdown({ b }: { b: RefundBreakdown }) {
  return (
    <dl className="ops-kv crm-breakdown">
      <dt>Plan paid</dt>
      <dd>{formatINR(b.planPaise)}</dd>
      <dt>Charged days</dt>
      <dd>
        {b.chargedDays} × {formatINR(b.standardDailyPaise)} (standard daily rate) = {formatINR(b.chargedPaise)}
      </dd>
      <dt>Balance</dt>
      <dd>{formatINR(b.balancePaise)}</dd>
      <dt>Missed-day credit</dt>
      <dd>{formatINR(b.refundableCreditPaise)}</dd>
      <dt>To original payment</dt>
      <dd>
        <strong>{formatINR(b.toSourcePaise)}</strong>
      </dd>
      <dt>To credit</dt>
      <dd>{formatINR(b.toCreditPaise)}</dd>
    </dl>
  );
}
