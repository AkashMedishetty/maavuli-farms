'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatINR } from '@/lib/pricing';
import type { RefundBreakdown } from '@/lib/models';
import { callApi, dayLabel, ErrorNote, useAction } from './account/api';

/**
 * Cancel one plan, the honest way: first GET /api/subscriptions/[id]/cancel for the
 * refund breakdown and the effective date (no writes), show it plainly, and only
 * then POST { confirm: true, reason? }. Nothing is cancelled until the customer
 * has seen exactly what they get back.
 */

interface Preview {
  breakdown: RefundBreakdown;
  effectiveDate: string;
}

interface CancelResult {
  status: 'cancelled';
  cancelEffectiveDate: string;
  daysDelivered: number;
  daysRemaining: number;
  refundId: string | null;
}

export function CancelSubscription({ subscriptionId }: { subscriptionId: string }) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<CancelResult | null>(null);
  const load = useAction();
  const submit = useAction();

  const fetchPreview = async () => {
    const p = await load.run(() => callApi<Preview>(`/api/subscriptions/${subscriptionId}/cancel`));
    if (p) setPreview(p);
  };

  const confirm = async () => {
    const r = await submit.run(() =>
      callApi<CancelResult>(`/api/subscriptions/${subscriptionId}/cancel`, {
        body: reason.trim() ? { confirm: true, reason: reason.trim() } : { confirm: true },
      }),
    );
    if (r) {
      setDone(r);
      router.refresh();
    }
  };

  if (done) {
    return (
      <div className="acct-ok" role="status">
        <p>
          Your plan is cancelled. There will be no deliveries from <strong>{dayLabel(done.cancelEffectiveDate)}</strong>.
        </p>
        {done.refundId ? <p>Your refund is listed under Refunds below.</p> : <p>No refund is due on this plan.</p>}
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="acct-stack">
        <p className="acct-muted">
          See exactly what you would get back before you decide. Nothing changes until you confirm.
        </p>
        <button type="button" className="acct-btn acct-btn-ghost" onClick={() => void fetchPreview()} disabled={load.pending}>
          {load.pending ? 'Working out your refund…' : 'Show my refund'}
        </button>
        <ErrorNote fail={load.fail} />
      </div>
    );
  }

  const b = preview.breakdown;
  const total = b.toSourcePaise + b.toCreditPaise;
  return (
    <div className="acct-stack">
      <p>
        If you cancel now, there are no deliveries from <strong>{dayLabel(preview.effectiveDate)}</strong> onward.
        Deliveries before that date are already confirmed, still arrive, and count as charged.
      </p>
      <dl className="acct-dl">
        <dt>You paid for this plan</dt>
        <dd>{formatINR(b.planPaise)}</dd>
        <dt>
          Days charged ({b.chargedDays} × {formatINR(b.standardDailyPaise)}, the standard 1-month daily rate)
        </dt>
        <dd>− {formatINR(b.chargedPaise)}</dd>
        <dt>Balance</dt>
        <dd>{formatINR(b.balancePaise)}</dd>
        {b.refundableCreditPaise > 0 && (
          <>
            <dt>Plus unused credit from missed days</dt>
            <dd>+ {formatINR(b.refundableCreditPaise)}</dd>
          </>
        )}
        <dt className="acct-dl-total">You get back</dt>
        <dd className="acct-dl-total">{formatINR(total)}</dd>
        {b.toSourcePaise > 0 && (
          <>
            <dt>— to your original payment method</dt>
            <dd>{formatINR(b.toSourcePaise)}</dd>
          </>
        )}
        {b.toCreditPaise > 0 && (
          <>
            <dt>— as Maavuli credit</dt>
            <dd>{formatINR(b.toCreditPaise)}</dd>
          </>
        )}
      </dl>
      <p className="acct-muted">
        Payments older than 6 months cannot go back to the card or bank automatically; if that applies we will ask you for
        a UPI id. Full terms: <a href="/legal/refunds">cancellation &amp; refund policy</a>.
      </p>
      <label className="acct-field">
        <span>Why are you cancelling? (optional)</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} />
      </label>
      <div className="acct-row">
        <button type="button" className="acct-btn acct-btn-danger" onClick={() => void confirm()} disabled={submit.pending}>
          {submit.pending ? 'Cancelling…' : 'Cancel my plan'}
        </button>
        <button type="button" className="acct-btn acct-btn-ghost" onClick={() => setPreview(null)} disabled={submit.pending}>
          Keep my plan
        </button>
      </div>
      <ErrorNote fail={submit.fail} />
    </div>
  );
}
