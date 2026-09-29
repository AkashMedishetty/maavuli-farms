'use client';

import { useState } from 'react';
import { ymdLabel } from '@/components/admin/ops/format';
import { MutationMessage, useMutation } from '@/components/admin/ops/useMutation';

/** Pause planned dates on the customer's behalf. owner/ops. Only open planned dates are offered. */
export default function PausePlan({
  mobile,
  subscriptionId,
  dates,
  remaining,
}: {
  mobile: string;
  subscriptionId: string;
  dates: string[];
  remaining: number;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const m = useMutation();

  if (!open) {
    return (
      <button type="button" className="ops-btn" onClick={() => setOpen(true)} disabled={dates.length === 0 || remaining <= 0}>
        Pause dates…
      </button>
    );
  }

  const toggle = (d: string) => setPicked(p => (p.includes(d) ? p.filter(x => x !== d) : [...p, d].sort()));
  const over = picked.length > remaining;

  return (
    <form
      className="crm-panel"
      onSubmit={e => {
        e.preventDefault();
        if (!picked.length || over) return;
        void m.run(
          `/api/admin/customers/${encodeURIComponent(mobile)}/subscriptions/${encodeURIComponent(subscriptionId)}/pause`,
          { method: 'POST', body: { dates: picked } },
          { fallback: 'Could not pause those dates', success: `Paused ${picked.length} date${picked.length === 1 ? '' : 's'}; the plan is extended by the same.` },
        ).then(r => {
          if (r) setPicked([]);
        });
      }}
    >
      <h4>Pause dates</h4>
      <p className="ops-muted">
        {remaining} pause day{remaining === 1 ? '' : 's'} left. Each paused day is added at the end of the plan.
      </p>
      <fieldset className="ops-chips crm-date-chips">
        <legend>Planned dates (open for changes)</legend>
        {dates.map(d => (
          <button key={d} type="button" className="ops-chip" aria-pressed={picked.includes(d)} disabled={m.pending} onClick={() => toggle(d)}>
            {ymdLabel(d)}
          </button>
        ))}
      </fieldset>
      {over && <p className="ops-error">Only {remaining} pause days are left — unselect some dates.</p>}
      <div className="ops-actions">
        <button type="submit" className="ops-btn ops-btn-primary" disabled={m.pending || picked.length === 0 || over}>
          {m.pending ? 'Pausing…' : picked.length ? `Pause ${picked.length} date${picked.length === 1 ? '' : 's'}` : 'Pause dates'}
        </button>
        <button type="button" className="ops-btn" disabled={m.pending} onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </form>
  );
}
