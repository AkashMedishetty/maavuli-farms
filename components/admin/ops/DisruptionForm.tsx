'use client';

import { useState } from 'react';
import { apiError, ymdLabel } from './format';
import { MutationMessage, useMutation } from './useMutation';

interface ZoneOpt {
  id: string;
  name: string;
  active: boolean;
}

interface Preview {
  affected: number;
  customers: number;
  unlockedRows: number;
}

/**
 * Declare a disruption in two steps: check the impact (GET preview, no writes),
 * then confirm (POST /api/admin/disruptions). Changing any input discards the preview.
 */
export default function DisruptionForm({ zones, minDate, maxDate }: { zones: ZoneOpt[]; minDate: string; maxDate: string }) {
  const [date, setDate] = useState(minDate);
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<{ error: string; issues: string[] } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const m = useMutation();

  const invalidate = () => {
    setPreview(null);
    setCheckError(null);
    setResult(null);
    m.reset();
  };

  const toggleZone = (id: string) => {
    invalidate();
    setZoneIds(z => (z.includes(id) ? z.filter(x => x !== id) : [...z, id]));
  };

  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 200;
  const scope = zoneIds.length === 0 ? 'every zone' : zones.filter(z => zoneIds.includes(z.id)).map(z => z.name).join(', ');

  async function check(e: React.FormEvent) {
    e.preventDefault();
    if (!reasonOk || checking) return;
    setChecking(true);
    setCheckError(null);
    setPreview(null);
    m.reset();
    try {
      const qs = new URLSearchParams({ date, zoneIds: zoneIds.join(',') });
      const r = await fetch(`/api/admin/disruptions/preview?${qs.toString()}`, { cache: 'no-store' });
      if (!r.ok) {
        setCheckError(await apiError(r, 'Could not check the impact'));
        return;
      }
      setPreview((await r.json()) as Preview);
    } catch {
      setCheckError({ error: 'Could not check the impact: the network request did not complete.', issues: [] });
    } finally {
      setChecking(false);
    }
  }

  async function confirm() {
    const res = await m.run(
      '/api/admin/disruptions',
      { method: 'POST', body: { date, reason: reason.trim(), ...(zoneIds.length ? { zoneIds } : {}) } },
      { fallback: 'Could not declare the disruption', success: 'Disruption recorded.' },
    );
    if (res) {
      const affected = typeof res.affected === 'number' ? res.affected : 0;
      const customers = typeof res.customers === 'number' ? res.customers : 0;
      const failed = typeof res.failed === 'number' ? res.failed : 0;
      setResult(
        `Recorded: ${affected} deliver${affected === 1 ? 'y' : 'ies'} marked not delivered, ${customers} customer${customers === 1 ? '' : 's'} notified.` +
          (failed ? ` ${failed} could not be marked — find them under Exceptions or on Today and resolve by hand.` : ''),
      );
      setPreview(null);
      setReason('');
      setZoneIds([]);
    }
  }

  const busy = checking || m.pending;

  return (
    <form onSubmit={check} className="ops-card" aria-labelledby="new-disruption-h">
      <h2 id="new-disruption-h">Declare a disruption</h2>
      <p className="ops-muted">
        Every affected delivery is marked not delivered, our fault: customers get a make-up day or credit, and a
        WhatsApp notice. This cannot be undone in bulk.
      </p>
      <label className="ops-field">
        <span>Date</span>
        <input
          type="date"
          value={date}
          min={minDate}
          max={maxDate}
          required
          disabled={busy}
          onChange={e => {
            invalidate();
            setDate(e.target.value);
          }}
        />
        <small>Today up to {ymdLabel(maxDate)}.</small>
      </label>

      <fieldset className="ops-chips">
        <legend>Zones (none selected = every zone)</legend>
        {zones.length === 0 ? (
          <p className="ops-muted">No zones exist.</p>
        ) : (
          zones.map(z => (
            <button key={z.id} type="button" className="ops-chip" aria-pressed={zoneIds.includes(z.id)} disabled={busy} onClick={() => toggleZone(z.id)}>
              {z.name}
              {z.active ? '' : ' (off)'}
            </button>
          ))
        )}
      </fieldset>

      <label className="ops-field">
        <span>Reason (customers see this)</span>
        <input
          type="text"
          value={reason}
          maxLength={200}
          required
          disabled={busy}
          placeholder="e.g. Heavy rain and flooding on the Uppal road"
          onChange={e => {
            invalidate();
            setReason(e.target.value);
          }}
        />
        <small>3–200 characters.</small>
      </label>

      {!preview && (
        <button type="submit" className="ops-btn ops-btn-primary" disabled={busy || !reasonOk || !date}>
          {checking ? 'Checking…' : 'Check impact'}
        </button>
      )}
      {checkError && (
        <div className="ops-error" role="alert">
          {checkError.error}
          {checkError.issues.length > 0 && (
            <ul>
              {checkError.issues.map(i => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {preview && (
        <div className="ops-warn" role="status" style={{ marginTop: '0.5rem' }}>
          {preview.affected === 0 ? (
            <>
              <p style={{ margin: 0 }}>
                No deliveries on {ymdLabel(date)} in {scope} would be affected. Nothing to declare.
              </p>
              <div className="ops-actions">
                <button type="button" className="ops-btn" onClick={invalidate}>
                  Check again
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                <strong>
                  {preview.affected} deliver{preview.affected === 1 ? 'y' : 'ies'} for {preview.customers} customer
                  {preview.customers === 1 ? '' : 's'}
                </strong>{' '}
                on {ymdLabel(date)} in {scope} will be marked not delivered (our fault) and compensated.
              </p>
              {preview.unlockedRows > 0 && (
                <p>The day is not locked yet; declaring this locks it first ({preview.unlockedRows} of these are still open).</p>
              )}
              <div className="ops-actions">
                <button type="button" className="ops-btn ops-btn-primary" disabled={m.pending} onClick={() => void confirm()}>
                  {m.pending ? 'Declaring…' : `Confirm: mark ${preview.affected} not delivered`}
                </button>
                <button type="button" className="ops-btn" disabled={m.pending} onClick={invalidate}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <MutationMessage error={m.error} issues={m.issues} done={result ? null : m.done} />
      {result && (
        <p className={result.includes('could not') ? 'ops-warn' : 'ops-ok'} role="status">
          {result}
        </p>
      )}
    </form>
  );
}
