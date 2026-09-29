'use client';

import { MutationMessage, useMutation } from './useMutation';

/** Simple one-shot action buttons for the ops screens. */

export function LockNowButton({ date, dateLabel }: { date: string; dateLabel: string }) {
  const m = useMutation();
  return (
    <div>
      <button
        type="button"
        className="ops-btn ops-btn-primary"
        disabled={m.pending}
        onClick={() => {
          if (!window.confirm(`Lock ${dateLabel} now? Customers can no longer change this date, and runs are frozen.`)) return;
          void m.run(
            `/api/admin/days/${encodeURIComponent(date)}/lock`,
            { method: 'POST' },
            { fallback: 'Could not lock the day', success: `${dateLabel} is locked.` },
          );
        }}
      >
        {m.pending ? 'Locking…' : 'Lock now'}
      </button>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </div>
  );
}

export function ReoptimiseButton({ riderId, riderName }: { riderId: string; riderName: string }) {
  const m = useMutation();
  return (
    <div>
      <button
        type="button"
        className="ops-btn ops-btn-small"
        disabled={m.pending}
        onClick={() =>
          void m.run(
            `/api/admin/routes/${encodeURIComponent(riderId)}/optimize`,
            { method: 'POST' },
            { fallback: `Could not re-optimise ${riderName}'s route`, success: 'Re-optimised — the table shows the new source and distance.' },
          )
        }
      >
        {m.pending ? 'Optimising…' : 'Re-optimise'}
      </button>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </div>
  );
}

export function PrintButton({ label = 'Print' }: { label?: string }) {
  return (
    <button type="button" className="ops-btn" onClick={() => window.print()}>
      {label}
    </button>
  );
}
