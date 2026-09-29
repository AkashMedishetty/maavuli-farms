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
  /** The UPI id the customer saved for this refund (prefills the payout field). */
  upiId: string | null;
}) {
  const process = useMutation();
  const manual = useMutation();
  const [open, setOpen] = useState(false);
  const [vpa, setVpa] = useState(upiId ?? '');
  const [utr, setUtr] = useState('');
  const [reason, setReason] = useState('');
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

  const savedUpi = upiId?.trim() || null;
  const overriding = savedUpi !== null && vpa.trim() !== '' && vpa.trim().toLowerCase() !== savedUpi.toLowerCase();
  // Put the API's error next to the field it is about.
  const errAt = manual.code === 'upi_required' ? 'upi' : manual.code === 'upi_override_reason' ? 'reason' : 'form';
  const msgAt = (where: typeof errAt) =>
    errAt === where ? <MutationMessage error={manual.error} issues={manual.issues} done={null} /> : null;

  return (
    <form
      className="crm-panel"
      onSubmit={e => {
        e.preventDefault();
        if (!utr.trim()) return;
        const body: { utr: string; upiId?: string; reason?: string } = { utr: utr.trim() };
        if (vpa.trim()) body.upiId = vpa.trim();
        if (reason.trim()) body.reason = reason.trim();
        void manual.run(
          url('manual'),
          { method: 'POST', body },
          { fallback: 'Could not record the payment', success: 'Recorded as paid by UPI. The customer is told on WhatsApp.' },
        );
      }}
    >
      <p className="ops-muted">Pay the amount from the business UPI app first, then record it here.</p>
      <label className="ops-field">
        <span>Customer UPI id</span>
        <input
          type="text"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={vpa}
          onChange={e => setVpa(e.target.value)}
          placeholder="name@bank"
          autoComplete="off"
          required={!savedUpi}
          disabled={manual.pending}
          aria-invalid={errAt === 'upi' && manual.error ? true : undefined}
        />
        {savedUpi && <small>The customer gave {savedUpi}. Pay that one unless they asked you to change it.</small>}
      </label>
      {msgAt('upi')}
      {!savedUpi && <p className="ops-warn">The customer has not given a UPI id yet — confirm it with them by phone.</p>}
      <label className="ops-field">
        <span>Reason (needed if you pay a different UPI id)</span>
        <input
          type="text"
          value={reason}
          onChange={e => setReason(e.target.value)}
          maxLength={300}
          autoComplete="off"
          required={overriding}
          disabled={manual.pending}
          aria-invalid={errAt === 'reason' && manual.error ? true : undefined}
        />
        {overriding && <small>This is not the UPI id the customer gave — say why (at least 5 characters).</small>}
      </label>
      {msgAt('reason')}
      <label className="ops-field">
        <span>UTR / transaction reference</span>
        <input type="text" autoCapitalize="characters" value={utr} onChange={e => setUtr(e.target.value)} autoComplete="off" required maxLength={30} disabled={manual.pending} />
      </label>
      <div className="ops-actions">
        <button type="submit" className="ops-btn ops-btn-primary" disabled={manual.pending || !utr.trim() || (!savedUpi && !vpa.trim())}>
          {manual.pending ? 'Saving…' : 'Record payment'}
        </button>
        <button type="button" className="ops-btn" disabled={manual.pending} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {errAt === 'form' ? <MutationMessage error={manual.error} issues={manual.issues} done={manual.done} /> : null}
    </form>
  );
}
