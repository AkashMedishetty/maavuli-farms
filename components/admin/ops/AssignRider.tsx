'use client';

import { useState } from 'react';
import { MutationMessage, useMutation } from './useMutation';

export interface RiderOption {
  id: string;
  name: string;
}

/** Hand a locked run (or the unassigned bucket) to a rider: POST /api/admin/runs/[id]/assign. */
export default function AssignRider({
  runId,
  riders,
  currentRiderId,
  label = 'Assign rider',
}: {
  runId: string;
  /** null = the rider list failed to load (not "there are no riders"). */
  riders: RiderOption[] | null;
  currentRiderId: string | null;
  label?: string;
}) {
  const [riderId, setRiderId] = useState('');
  const m = useMutation();

  if (riders === null) {
    return <p className="ops-muted">The rider list failed to load. Reload the page to assign a rider.</p>;
  }
  const choices = riders.filter(r => r.id !== currentRiderId);

  if (choices.length === 0) {
    return <p className="ops-muted">No other active rider to assign. Add one under Riders &amp; zones.</p>;
  }

  return (
    <form
      className="ops-actions"
      onSubmit={e => {
        e.preventDefault();
        if (!riderId) return;
        const name = riders.find(r => r.id === riderId)?.name ?? 'the rider';
        void m.run(
          `/api/admin/runs/${encodeURIComponent(runId)}/assign`,
          { method: 'POST', body: { riderId } },
          { fallback: 'Could not assign the rider', success: `Assigned to ${name}.` },
        );
      }}
    >
      <label className="ops-field" style={{ marginBottom: 0 }}>
        <span>{label}</span>
        <select value={riderId} onChange={e => setRiderId(e.target.value)} disabled={m.pending} required>
          <option value="">Choose a rider…</option>
          {choices.map(r => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="ops-btn ops-btn-primary" disabled={m.pending || !riderId}>
        {m.pending ? 'Assigning…' : 'Assign'}
      </button>
      <div style={{ flexBasis: '100%' }}>
        <MutationMessage error={m.error} issues={m.issues} done={m.done} />
      </div>
    </form>
  );
}
