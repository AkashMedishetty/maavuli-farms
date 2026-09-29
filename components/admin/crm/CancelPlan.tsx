'use client';

import { useState } from 'react';
import type { RefundBreakdown } from '@/lib/models';
import { apiError, ymdLabel } from '@/components/admin/ops/format';
import { MutationMessage, useMutation } from '@/components/admin/ops/useMutation';
import Breakdown from './Breakdown';

type Preview = { breakdown: RefundBreakdown; effectiveDate: string };

const base = (mobile: string, id: string) =>
  `/api/admin/customers/${encodeURIComponent(mobile)}/subscriptions/${encodeURIComponent(id)}`;

/** Cancel a plan on the customer's behalf: load the refund preview, then confirm with a reason. owner/ops. */
export default function CancelPlan({ mobile, subscriptionId }: { mobile: string; subscriptionId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState('');
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const m = useMutation();

  async function load() {
    setOpen(true);
    setLoading(true);
    setLoadErr(null);
    setPreview(null);
    try {
      const res = await fetch(`${base(mobile, subscriptionId)}/cancel`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) {
        const e = await apiError(res, 'Could not load the refund preview');
        setLoadErr(e.error);
      } else {
        const body = (await res.json()) as { preview: Preview };
        setPreview(body.preview);
      }
    } catch {
      setLoadErr('Could not load the refund preview: the network request did not complete.');
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="ops-btn ops-btn-danger" onClick={() => void load()}>
        Cancel plan…
      </button>
    );
  }

  if (m.done) return <MutationMessage error={null} issues={[]} done={doneMsg ?? m.done} />;

  return (
    <div className="crm-panel" aria-live="polite">
      <h4>Cancel this plan</h4>
      {loading && <p className="ops-pending">Loading the refund preview…</p>}
      {loadErr && (
        <div>
          <p className="ops-error" role="alert">
            {loadErr}
          </p>
          <div className="ops-actions">
            <button type="button" className="ops-btn" onClick={() => void load()}>
              Retry
            </button>
            <button type="button" className="ops-btn" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
      {preview && (
        <form
          onSubmit={e => {
            e.preventDefault();
            if (reason.trim().length < 3) return;
            const b = preview.breakdown;
            const noRefund =
              b.toCreditPaise > 0
                ? 'Plan cancelled. No refund is due; the balance went to the customer’s credit.'
                : 'Plan cancelled. No refund is due.';
            const started = 'Plan cancelled. The refund has been started (see Refunds below).';
            void m
              .run(
                `${base(mobile, subscriptionId)}/cancel`,
                { method: 'POST', body: { reason: reason.trim() } },
                { fallback: 'Could not cancel the plan', success: b.toSourcePaise > 0 ? started : noRefund },
              )
              .then(r => {
                // The server's answer wins over the preview (numbers can move between preview and confirm).
                const res = (r?.result ?? null) as { refundId?: string | null } | null;
                if (res && 'refundId' in res) setDoneMsg(res.refundId ? started : noRefund);
              });
          }}
        >
          <p>
            Deliveries stop from <strong>{ymdLabel(preview.effectiveDate)}</strong> (the first date still open). Days
            already locked or delivered are charged. If this preview is taken again later, the numbers can change.
          </p>
          <Breakdown b={preview.breakdown} />
          <label className="ops-field">
            <span>Reason (required — what the customer said)</span>
            <textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={300} required disabled={m.pending} />
          </label>
          <div className="ops-actions">
            <button type="submit" className="ops-btn ops-btn-danger" disabled={m.pending || reason.trim().length < 3}>
              {m.pending ? 'Cancelling…' : 'Confirm cancellation'}
            </button>
            <button type="button" className="ops-btn" disabled={m.pending} onClick={() => setOpen(false)}>
              Keep the plan
            </button>
          </div>
          <MutationMessage error={m.error} issues={m.issues} done={null} />
        </form>
      )}
    </div>
  );
}
