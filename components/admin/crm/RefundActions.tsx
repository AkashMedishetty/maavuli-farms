'use client';

import { useState } from 'react';
import { MutationMessage, useMutation } from '@/components/admin/ops/useMutation';

/**
 * Refund controls (owner/ops): (re)start a pending/failed Razorpay refund, or record
 * the UPI payout ops made for an awaiting_upi refund.
 */
export default function RefundActions({
  refundId,
  status,
  upiId,
}: {
  refundId: string;
  status: string;
  upiId: string | null;
}) {
  const process = useMutation();
  const manual = useMutation();
  const [open, setOpen] = useState(false);
  const [vpa, setVpa] = useState(upiId ?? '');
  const [utr, setUtr] = useState('');
  const url = (s: string) => `/api/admin/refunds/${encodeURIComponent(refundId)}/${s}`;

  if (status === 'pending' || status === 'failed') {
    return (
      <div>
        <div className="ops-actions">
          <button
            type="button"
            className="ops-btn ops-btn-primary"
            disabled={process.pending}
            onClick={() =>
              void process.run(
                url('process'),
                { method: 'POST' },
                { fallback: 'Could not start the refund', success: 'Refund started at Razorpay (or moved to UPI payout if it cannot).' },
              )
            }
          >
            {process.pending ? 'Starting…' : status === 'failed' ? 'Retry refund' : 'Process refund'}
          </button>
        </div>
        {status === 'failed' && <p className="ops-muted">Before retrying a failed refund, check the Razorpay dashboard that no refund was created.</p>}
        <MutationMessage error={process.error} issues={process.issues} done={process.done} />
      </div>
    );
  }

  if (status !== 'awaiting_upi') return null;

  if (!open) {
    return (
      <div className="ops-actions">
        <button type="button" className="ops-btn ops-btn-primary" onClick={() => setOpen(true)}>
          Record UPI payment…
        </button>
      </div>
    );
  }

  return (
    <form
      className="crm-panel"
      onSubmit={e => {
        e.preventDefault();
        if (!vpa.trim() || !utr.trim()) return;
        void manual.run(
          url('manual'),
          { method: 'POST', body: { upiId: vpa.trim(), utr: utr.trim() } },
          { fallback: 'Could not record the payment', success: 'Recorded as paid by UPI. The customer is told on WhatsApp.' },
        );
      }}
    >
      <p className="ops-muted">Pay the amount from the business UPI app first, then record it here.</p>
      <label className="ops-field">
        <span>Customer UPI id</span>
        <input value={vpa} onChange={e => setVpa(e.target.value)} placeholder="name@bank" autoComplete="off" required disabled={manual.pending} />
      </label>
      {!upiId && <p className="ops-warn">The customer has not given a UPI id yet — confirm it with them by phone.</p>}
      <label className="ops-field">
        <span>UTR / transaction reference</span>
        <input value={utr} onChange={e => setUtr(e.target.value)} autoComplete="off" required maxLength={30} disabled={manual.pending} />
      </label>
      <div className="ops-actions">
        <button type="submit" className="ops-btn ops-btn-primary" disabled={manual.pending || !vpa.trim() || !utr.trim()}>
          {manual.pending ? 'Saving…' : 'Record payment'}
        </button>
        <button type="button" className="ops-btn" disabled={manual.pending} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <MutationMessage error={manual.error} issues={manual.issues} done={manual.done} />
    </form>
  );
}
