'use client';

import { useState } from 'react';
import { MutationMessage, useMutation } from './useMutation';

export interface SettingsValues {
  cutoffTime: string;
  windowStart: string;
  windowEnd: string;
  dayCloseTime: string;
  photoRetentionDays: number;
  renewalReminderDays: number[];
  unpaidOrderExpiryMinutes: number;
  proofDistanceFlagM: number;
}

type Draft = Record<keyof SettingsValues, string>;

function toDraft(v: SettingsValues): Draft {
  return {
    cutoffTime: v.cutoffTime,
    windowStart: v.windowStart,
    windowEnd: v.windowEnd,
    dayCloseTime: v.dayCloseTime,
    photoRetentionDays: String(v.photoRetentionDays),
    renewalReminderDays: v.renewalReminderDays.join(', '),
    unpaidOrderExpiryMinutes: String(v.unpaidOrderExpiryMinutes),
    proofDistanceFlagM: String(v.proofDistanceFlagM),
  };
}

/** Numbers are sent as typed; the API (lib/settings.validateOpsSettings) is the judge and returns issues[]. */
function toPatch(d: Draft): Record<string, unknown> {
  const num = (s: string) => (s.trim() === '' ? s : Number(s));
  return {
    cutoffTime: d.cutoffTime,
    windowStart: d.windowStart,
    windowEnd: d.windowEnd,
    dayCloseTime: d.dayCloseTime,
    photoRetentionDays: num(d.photoRetentionDays),
    renewalReminderDays: d.renewalReminderDays
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number),
    unpaidOrderExpiryMinutes: num(d.unpaidOrderExpiryMinutes),
    proofDistanceFlagM: num(d.proofDistanceFlagM),
  };
}

const TIME_FIELDS: { key: 'cutoffTime' | 'windowStart' | 'windowEnd' | 'dayCloseTime'; label: string; hint: string }[] = [
  { key: 'cutoffTime', label: 'Cutoff', hint: 'On the day before delivery. After this, customers cannot change that date.' },
  { key: 'windowStart', label: 'Delivery window opens', hint: 'Shown to customers; riders can start runs.' },
  { key: 'windowEnd', label: 'Delivery window closes', hint: 'Shown to customers.' },
  { key: 'dayCloseTime', label: 'Day closes', hint: 'Unmarked deliveries become unconfirmed. Must be after the window closes.' },
];

const NUM_FIELDS: { key: 'photoRetentionDays' | 'unpaidOrderExpiryMinutes' | 'proofDistanceFlagM'; label: string; hint: string }[] = [
  { key: 'photoRetentionDays', label: 'Keep doorstep photos (days)', hint: '7–365.' },
  { key: 'unpaidOrderExpiryMinutes', label: 'Unpaid orders expire after (minutes)', hint: '5–1440.' },
  { key: 'proofDistanceFlagM', label: 'Flag a delivery tap further than (metres)', hint: '20–2000 from the customer pin.' },
];

export default function SettingsForm({ initial }: { initial: SettingsValues }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const m = useMutation();
  const set = (k: keyof Draft, v: string) => {
    setDraft(d => ({ ...d, [k]: v }));
    if (m.done) m.reset();
  };

  return (
    <form
      className="ops-card"
      onSubmit={e => {
        e.preventDefault();
        void m.run(
          '/api/admin/settings',
          { method: 'PUT', body: toPatch(draft) },
          { fallback: 'Could not save settings', success: 'Saved. New times apply to dates that have not locked yet.' },
        );
      }}
    >
      <h2>Daily clock (IST)</h2>
      <div className="ops-form-grid">
        {TIME_FIELDS.map(f => (
          <label key={f.key} className="ops-field">
            <span>{f.label}</span>
            <input type="time" value={draft[f.key]} onChange={e => set(f.key, e.target.value)} required disabled={m.pending} />
            <small>{f.hint}</small>
          </label>
        ))}
      </div>
      <h2>Limits</h2>
      <div className="ops-form-grid">
        {NUM_FIELDS.map(f => (
          <label key={f.key} className="ops-field">
            <span>{f.label}</span>
            <input type="number" inputMode="numeric" step={1} value={draft[f.key]} onChange={e => set(f.key, e.target.value)} required disabled={m.pending} />
            <small>{f.hint}</small>
          </label>
        ))}
        <label className="ops-field">
          <span>Renewal reminders (days before the plan ends)</span>
          <input type="text" inputMode="numeric" value={draft.renewalReminderDays} onChange={e => set('renewalReminderDays', e.target.value)} disabled={m.pending} placeholder="7, 3, 1" />
          <small>Up to 5 numbers, 1–30, comma separated.</small>
        </label>
      </div>
      <div className="ops-actions">
        <button type="submit" className="ops-btn ops-btn-primary" disabled={m.pending}>
          {m.pending ? 'Saving…' : 'Save settings'}
        </button>
        <button type="button" className="ops-btn" disabled={m.pending} onClick={() => { setDraft(toDraft(initial)); m.reset(); }}>
          Undo changes
        </button>
      </div>
      <MutationMessage error={m.error} issues={m.issues} done={m.done} />
    </form>
  );
}
