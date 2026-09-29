'use client';

import { useState } from 'react';
import { MutationMessage, useMutation } from '@/components/admin/ops/useMutation';

/** Turn WhatsApp off because the customer asked. All staff. Turning it on is the customer's own act. */
export default function WhatsappOptOut({ mobile }: { mobile: string }) {
  const [confirm, setConfirm] = useState(false);
  const m = useMutation();

  if (!confirm) {
    return (
      <button type="button" className="ops-btn" onClick={() => setConfirm(true)}>
        Turn WhatsApp off (customer asked)
      </button>
    );
  }
  return (
    <div className="crm-panel">
      <p>The customer will get no WhatsApp messages (delivery photos, refunds, reminders) until they turn it back on from their account.</p>
      <div className="ops-actions">
        <button
          type="button"
          className="ops-btn ops-btn-danger"
          disabled={m.pending}
          onClick={() =>
            void m.run(
              `/api/admin/customers/${encodeURIComponent(mobile)}/whatsapp`,
              { method: 'POST', body: { optIn: false } },
              { fallback: 'Could not turn WhatsApp off', success: 'WhatsApp turned off.' },
            )
          }
        >
          {m.pending ? 'Turning off…' : 'Yes, turn it off'}
        </button>
        <button type="button" className="ops-btn" disabled={m.pending} onClick={() => setConfirm(false)}>
          Keep it on
        </button>
      </div>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </div>
  );
}
