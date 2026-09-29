'use client';

import { useState } from 'react';
import { MutationMessage, useMutation } from '@/components/admin/ops/useMutation';

const ROLES = [
  { id: 'support', label: 'Support — reads everything, goodwill up to ₹200, resolves issues' },
  { id: 'ops', label: 'Ops — runs the day, refunds, pauses/cancels, goodwill up to ₹1,000' },
  { id: 'owner', label: 'Owner — everything, including settings and staff' },
] as const;

/** Add a staff member. owner only (the page is owner-only and the API refuses others). */
export function AddStaff() {
  const [mobile, setMobile] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'support' | 'ops' | 'owner'>('support');
  const m = useMutation();
  const valid = /^\d{10}$/.test(mobile.replace(/\D/g, '').slice(-10)) && name.trim().length >= 2;

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        if (!valid) return;
        void m
          .run(
            '/api/admin/staff',
            { method: 'POST', body: { mobile: mobile.trim(), name: name.trim(), role } },
            { fallback: 'Could not add the staff member', success: `Added ${name.trim()}. They sign in with an OTP to this number.` },
          )
          .then(r => {
            if (r) {
              setMobile('');
              setName('');
              setRole('support');
            }
          });
      }}
    >
      <label className="ops-field">
        <span>Mobile</span>
        <input inputMode="tel" value={mobile} onChange={e => setMobile(e.target.value)} placeholder="10 digits" required disabled={m.pending} />
      </label>
      <label className="ops-field">
        <span>Name</span>
        <input value={name} onChange={e => setName(e.target.value)} maxLength={60} required disabled={m.pending} />
      </label>
      <fieldset className="ops-chips">
        <legend>Role</legend>
        {ROLES.map(r => (
          <button key={r.id} type="button" className="ops-chip" aria-pressed={role === r.id} disabled={m.pending} onClick={() => setRole(r.id)}>
            {r.id === 'support' ? 'Support' : r.id === 'ops' ? 'Ops' : 'Owner'}
          </button>
        ))}
      </fieldset>
      <p className="ops-muted">{ROLES.find(r => r.id === role)?.label}</p>
      <div className="ops-actions">
        <button type="submit" className="ops-btn ops-btn-primary" disabled={m.pending || !valid}>
          {m.pending ? 'Adding…' : 'Add staff member'}
        </button>
      </div>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </form>
  );
}

/** Role change + deactivate/reactivate for one staff row. Hidden for env owners and for yourself. */
export function StaffControls({ mobile, role, active }: { mobile: string; role: string; active: boolean }) {
  const [newRole, setNewRole] = useState(role);
  const [confirmOff, setConfirmOff] = useState(false);
  const m = useMutation();
  const url = `/api/admin/staff/${encodeURIComponent(mobile)}`;

  return (
    <div>
      {active && (
        <div className="ops-actions">
          <label className="ops-field" style={{ margin: 0 }}>
            <span>Role</span>
            <select value={newRole} onChange={e => setNewRole(e.target.value)} disabled={m.pending} style={{ minHeight: 44, fontSize: 16 }}>
              <option value="support">Support</option>
              <option value="ops">Ops</option>
              <option value="owner">Owner</option>
            </select>
          </label>
          <button
            type="button"
            className="ops-btn"
            disabled={m.pending || newRole === role}
            onClick={() => void m.run(url, { method: 'PATCH', body: { role: newRole } }, { fallback: 'Could not change the role', success: 'Role changed.' })}
          >
            {m.pending ? 'Saving…' : 'Change role'}
          </button>
        </div>
      )}
      <div className="ops-actions">
        {active ? (
          confirmOff ? (
            <>
              <button
                type="button"
                className="ops-btn ops-btn-danger"
                disabled={m.pending}
                onClick={() => void m.run(url, { method: 'PATCH', body: { active: false } }, { fallback: 'Could not deactivate', success: 'Deactivated — they lose admin access now.' })}
              >
                {m.pending ? 'Deactivating…' : 'Yes, deactivate'}
              </button>
              <button type="button" className="ops-btn" disabled={m.pending} onClick={() => setConfirmOff(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="ops-btn ops-btn-danger" onClick={() => setConfirmOff(true)}>
              Deactivate…
            </button>
          )
        ) : (
          <button
            type="button"
            className="ops-btn"
            disabled={m.pending}
            onClick={() => void m.run(url, { method: 'PATCH', body: { active: true } }, { fallback: 'Could not reactivate', success: 'Reactivated.' })}
          >
            {m.pending ? 'Reactivating…' : 'Reactivate'}
          </button>
        )}
      </div>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </div>
  );
}
