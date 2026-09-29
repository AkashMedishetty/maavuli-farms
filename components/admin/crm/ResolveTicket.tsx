'use client';

import { useState } from 'react';
import { MutationMessage, useMutation } from '@/components/admin/ops/useMutation';

/** Resolve a support ticket with a note (the customer gets a ticket_update WhatsApp). owner/ops/support. */
export default function ResolveTicket({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const m = useMutation();

  if (m.done) return <MutationMessage error={null} issues={[]} done={m.done} />;
  if (!open) {
    return (
      <button type="button" className="ops-btn" onClick={() => setOpen(true)}>
        Resolve…
      </button>
    );
  }
  return (
    <form
      className="crm-panel"
      onSubmit={e => {
        e.preventDefault();
        if (note.trim().length < 3) return;
        void m.run(
          `/api/admin/tickets/${encodeURIComponent(ticketId)}/resolve`,
          { method: 'POST', body: { resolution: note.trim() } },
          { fallback: 'Could not resolve the issue', success: 'Resolved. The customer is told on WhatsApp (if opted in).' },
        );
      }}
    >
      <label className="ops-field">
        <span>What was done (sent to the customer)</span>
        <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} required disabled={m.pending} />
      </label>
      <div className="ops-actions">
        <button type="submit" className="ops-btn ops-btn-primary" disabled={m.pending || note.trim().length < 3}>
          {m.pending ? 'Resolving…' : 'Resolve'}
        </button>
        <button type="button" className="ops-btn" disabled={m.pending} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <MutationMessage error={m.error} issues={m.issues} done={null} />
    </form>
  );
}
