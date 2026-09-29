'use client';

import { useState } from 'react';
import { REASONS } from './format';
import { MutationMessage, useMutation } from './useMutation';

type Mode = 'unconfirmed' | 'unknown_fault' | 'flagged_proof';

const OUTCOME = (id: string) => `/api/admin/deliveries/${encodeURIComponent(id)}/outcome`;

function FaultChips({ value, onChange, disabled, allowUnknown }: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  allowUnknown: boolean;
}) {
  const opts = [
    { id: 'ours', label: 'Our fault (compensate)' },
    { id: 'customer', label: 'Customer side' },
    ...(allowUnknown ? [{ id: 'unknown', label: 'Decide later' }] : []),
  ];
  return (
    <fieldset className="ops-chips">
      <legend>Whose fault?</legend>
      {opts.map(o => (
        <button key={o.id} type="button" className="ops-chip" aria-pressed={value === o.id} disabled={disabled} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

function NotDeliveredForm({ deliveryId, onCancel }: { deliveryId: string; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [fault, setFault] = useState('');
  const [note, setNote] = useState('');
  const m = useMutation();
  const def = REASONS.find(r => r.id === reason)?.fault;
  const effectiveFault = fault || def || '';

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        if (!reason) return;
        void m.run(
          OUTCOME(deliveryId),
          {
            method: 'POST',
            body: {
              action: 'not_delivered',
              reason,
              ...(effectiveFault ? { fault: effectiveFault } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
            },
          },
          { fallback: 'Could not mark not delivered', success: 'Marked not delivered.' },
        );
      }}
    >
      <fieldset className="ops-chips">
        <legend>Reason</legend>
        {REASONS.map(r => (
          <button
            key={r.id}
            type="button"
            className="ops-chip"
            aria-pressed={reason === r.id}
            disabled={m.pending}
            onClick={() => {
              setReason(r.id);
              setFault('');
            }}
          >
            {r.label}
          </button>
        ))}
      </fieldset>
      {reason && (
        <FaultChips value={effectiveFault} onChange={setFault} disabled={m.pending} allowUnknown />
      )}
      <label className="ops-field">
        <span>Note (optional)</span>
        <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} disabled={m.pending} />
      </label>
      <div className="ops-actions">
        <button type="submit" className="ops-btn ops-btn-primary" disabled={m.pending || !reason}>
          {m.pending ? 'Saving…' : 'Save: not delivered'}
        </button>
        <button type="button" className="ops-btn" onClick={onCancel} disabled={m.pending}>
          Cancel
        </button>
      </div>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </form>
  );
}

function DeliveredForm({ deliveryId, onCancel }: { deliveryId: string; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const m = useMutation();
  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        if (!note.trim()) return;
        void m.run(
          OUTCOME(deliveryId),
          { method: 'POST', body: { action: 'delivered', note: note.trim() } },
          { fallback: 'Could not mark delivered', success: 'Marked delivered.' },
        );
      }}
    >
      <label className="ops-field">
        <span>How do you know it was delivered? (required)</span>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          maxLength={500}
          required
          placeholder="e.g. rider confirmed by phone at 7:40"
          disabled={m.pending}
        />
      </label>
      <div className="ops-actions">
        <button type="submit" className="ops-btn ops-btn-primary" disabled={m.pending || !note.trim()}>
          {m.pending ? 'Saving…' : 'Save: delivered'}
        </button>
        <button type="button" className="ops-btn" onClick={onCancel} disabled={m.pending}>
          Cancel
        </button>
      </div>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </form>
  );
}

function SetFaultForm({ deliveryId }: { deliveryId: string }) {
  const [fault, setFault] = useState('');
  const m = useMutation();
  return (
    <div>
      <FaultChips value={fault} onChange={setFault} disabled={m.pending} allowUnknown={false} />
      <div className="ops-actions">
        <button
          type="button"
          className="ops-btn ops-btn-primary"
          disabled={m.pending || !fault}
          onClick={() =>
            void m.run(
              OUTCOME(deliveryId),
              { method: 'POST', body: { action: 'set_fault', fault } },
              {
                fallback: 'Could not set the fault',
                success: fault === 'ours' ? 'Set to our fault — the customer is compensated.' : 'Set to customer side.',
              },
            )
          }
        >
          {m.pending ? 'Saving…' : 'Save fault'}
        </button>
      </div>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </div>
  );
}

/** A flagged proof that ops checked and accept: clears the flag, the stop stays delivered. */
function AcceptProofForm({ deliveryId, onCancel }: { deliveryId: string; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const m = useMutation();
  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        if (note.trim().length < 3) return;
        void m.run(
          OUTCOME(deliveryId),
          { method: 'POST', body: { action: 'clear_flag', note: note.trim() } },
          { fallback: 'Could not clear the flag', success: 'Proof accepted — flag cleared.' },
        );
      }}
    >
      <label className="ops-field">
        <span>Why is this proof fine? (required)</span>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          maxLength={300}
          required
          placeholder="e.g. called the customer, milk received; gate is 200 m from the pin"
          disabled={m.pending}
        />
      </label>
      <div className="ops-actions">
        <button type="submit" className="ops-btn ops-btn-primary" disabled={m.pending || note.trim().length < 3}>
          {m.pending ? 'Saving…' : 'Accept proof'}
        </button>
        <button type="button" className="ops-btn" onClick={onCancel} disabled={m.pending}>
          Cancel
        </button>
      </div>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </form>
  );
}

/** Resolution controls for one exception (owner/ops only — the page hides it for support). */
export default function ResolveDelivery({ deliveryId, mode }: { deliveryId: string; mode: Mode }) {
  const [open, setOpen] = useState<'delivered' | 'not_delivered' | 'accept' | null>(null);

  if (mode === 'unknown_fault') return <SetFaultForm deliveryId={deliveryId} />;

  if (open === 'delivered') return <DeliveredForm deliveryId={deliveryId} onCancel={() => setOpen(null)} />;
  if (open === 'not_delivered') return <NotDeliveredForm deliveryId={deliveryId} onCancel={() => setOpen(null)} />;
  if (open === 'accept') return <AcceptProofForm deliveryId={deliveryId} onCancel={() => setOpen(null)} />;

  return (
    <div className="ops-actions">
      {mode === 'unconfirmed' && (
        <button type="button" className="ops-btn" onClick={() => setOpen('delivered')}>
          Delivered
        </button>
      )}
      {mode === 'flagged_proof' && (
        <button type="button" className="ops-btn" onClick={() => setOpen('accept')}>
          Proof is fine
        </button>
      )}
      <button type="button" className="ops-btn ops-btn-danger" onClick={() => setOpen('not_delivered')}>
        {mode === 'flagged_proof' ? 'Proof is wrong: not delivered' : 'Not delivered'}
      </button>
    </div>
  );
}
