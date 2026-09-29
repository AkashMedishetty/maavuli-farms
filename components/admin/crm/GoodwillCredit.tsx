'use client';

import { useState } from 'react';
import { formatINR } from '@/lib/pricing';
import { MutationMessage, useMutation } from '@/components/admin/ops/useMutation';

/** Parse "150" / "150.50" rupees into integer paise, or null. */
function toPaise(v: string): number | null {
  const t = v.trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return null;
  const [r = '0', p = ''] = t.split('.');
  const paise = Number(r) * 100 + Number(p.padEnd(2, '0'));
  return paise > 0 ? paise : null;
}

/** Goodwill credit (not refundable) via POST /api/admin/credits. All staff, per-role cap. */
export default function GoodwillCredit({ mobile, capPaise }: { mobile: string; capPaise: number }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const m = useMutation();
  const paise = toPaise(amount);
  const overCap = paise !== null && paise > capPaise;
  const valid = paise !== null && !overCap && note.trim().length >= 3;

  if (!open) {
    return (
      <button type="button" className="ops-btn" onClick={() => setOpen(true)}>
        Give goodwill credit…
      </button>
    );
  }

  return (
    <form
      className="crm-panel"
      onSubmit={e => {
        e.preventDefault();
        if (!valid || paise === null) return;
        void m
          .run(
            '/api/admin/credits',
            { method: 'POST', body: { mobile, amountPaise: paise, note: note.trim() } },
            { fallback: 'Could not add the credit', success: `Added ${formatINR(paise)} goodwill credit.` },
          )
          .then(r => {
            if (r) {
              setAmount('');
              setNote('');
            }
          });
      }}
    >
      <h4>Goodwill credit</h4>
      <p className="ops-muted">Not refundable. Your role can give up to {formatINR(capPaise)} per entry.</p>
      <label className="ops-field">
        <span>Amount (₹)</span>
        <input type="text" inputMode="decimal" autoComplete="off" value={amount} onChange={e => setAmount(e.target.value)} placeholder="e.g. 115" disabled={m.pending} required />
      </label>
      {amount && paise === null && <p className="ops-error">Enter an amount in rupees, like 115 or 57.50.</p>}
      {overCap && <p className="ops-error">That is above your cap of {formatINR(capPaise)}.</p>}
      <label className="ops-field">
        <span>Why (required, the customer does not see this)</span>
        <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={300} required disabled={m.pending} />
      </label>
      <div className="ops-actions">
        <button type="submit" className="ops-btn ops-btn-primary" disabled={m.pending || !valid}>
          {m.pending ? 'Adding…' : paise && !overCap ? `Add ${formatINR(paise)}` : 'Add credit'}
        </button>
        <button type="button" className="ops-btn" disabled={m.pending} onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </form>
  );
}
