'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Admin: riders and which zone each one runs.
 *
 * The day lock buckets each date's stops by the zone they fall in and that zone's
 * rider, so this panel is where the two are wired together. Reads are open to all
 * staff; writes (canEdit) are owner/ops, and the API enforces that regardless.
 * A rider's phone is their LOGIN for the rider app (/rider, OTP to that number).
 */

interface Rider {
  id: string;
  name: string;
  phone: string | null;
  active: boolean;
  startLocation: { lat: number; lng: number } | null;
  note: string | null;
}

interface Zone {
  id: string;
  name: string;
  active: boolean;
  riderId: string | null;
}

async function errorOf(r: Response, fallback: string): Promise<string> {
  const b = (await r.json().catch(() => null)) as { error?: unknown; issues?: unknown } | null;
  const msg = b && typeof b.error === 'string' ? b.error : `${fallback} (HTTP ${r.status})`;
  const issues = b && Array.isArray(b.issues) ? b.issues.filter((i): i is string => typeof i === 'string') : [];
  return issues.length ? `${msg}: ${issues.join('; ')}` : msg;
}

export default function RidersPanel({ canEdit = false, refreshKey = 0 }: { canEdit?: boolean; refreshKey?: number }) {
  const [riders, setRiders] = useState<Rider[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', lat: '', lng: '' });

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [rr, zr] = await Promise.all([
        fetch('/api/admin/riders', { cache: 'no-store' }),
        fetch('/api/admin/zones', { cache: 'no-store' }),
      ]);
      if (!rr.ok) throw new Error(await errorOf(rr, 'Could not load riders'));
      if (!zr.ok) throw new Error(await errorOf(zr, 'Could not load zones'));
      const rb = (await rr.json()) as { riders?: Rider[] };
      const zb = (await zr.json()) as { zones?: Zone[] };
      setRiders(rb.riders ?? []);
      setZones(zb.zones ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load riders.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function mutate(tag: string, url: string, init: RequestInit, fallback: string, success: string): Promise<boolean> {
    setBusy(tag);
    setActionError(null);
    setNotice(null);
    try {
      const r = await fetch(url, init);
      if (!r.ok) {
        setActionError(await errorOf(r, fallback));
        return false;
      }
      setNotice(success);
      await load();
      return true;
    } catch {
      setActionError(`${fallback}: the network request did not complete.`);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const addRider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || busy) return;
    const body: Record<string, string> = { name: form.name.trim() };
    if (form.phone.trim()) body.phone = form.phone.trim();
    if (form.lat.trim() && form.lng.trim()) {
      body.lat = form.lat.trim();
      body.lng = form.lng.trim();
    }
    const okd = await mutate('add', '/api/admin/riders', json('POST', body), 'Could not add the rider', `Added ${body.name}.`);
    if (okd) setForm({ name: '', phone: '', lat: '', lng: '' });
  };

  const editPhone = async (rider: Rider) => {
    const next = window.prompt(
      `Sign-in phone for ${rider.name} (10 digits). Leave empty to remove — they will not be able to sign in.`,
      rider.phone ?? '',
    );
    if (next === null) return;
    await mutate(`phone-${rider.id}`, '/api/admin/riders', json('PATCH', { id: rider.id, phone: next.trim() }), 'Could not update the phone', 'Phone updated.');
  };

  const deleteRider = async (rider: Rider) => {
    if (!window.confirm(`Remove rider "${rider.name}"? Their zones become unassigned. Turning them off keeps history instead.`)) return;
    await mutate(`del-${rider.id}`, `/api/admin/riders?id=${encodeURIComponent(rider.id)}`, { method: 'DELETE' }, 'Could not remove the rider', `Removed ${rider.name}.`);
  };

  return (
    <section className="ops-card" aria-labelledby="riders-h">
      <h2 id="riders-h">Riders</h2>
      <p className="ops-muted">
        The phone is the number the rider signs in with at <code>/rider</code> (a one-time code is sent to it). Each zone
        below goes to one rider; the day lock gives that rider every stop in the zone.
      </p>

      {actionError && (
        <p className="ops-error" role="alert">
          {actionError}
        </p>
      )}
      {notice && (
        <p className="ops-ok" role="status">
          {notice}
        </p>
      )}

      {canEdit && (
        <form onSubmit={addRider} className="ops-card" style={{ background: 'var(--ops-soft)' }}>
          <h3>Add a rider</h3>
          <div className="ops-form-grid">
            <label className="ops-field">
              <span>Name</span>
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required maxLength={80} />
            </label>
            <label className="ops-field">
              <span>Sign-in phone</span>
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="off"
                placeholder="10-digit mobile"
                value={form.phone}
                onChange={e => setForm({ ...form, phone: e.target.value })}
              />
              <small>Without a phone the rider cannot use the rider app.</small>
            </label>
            <label className="ops-field">
              <span>Start point lat (optional)</span>
              <input type="text" inputMode="decimal" value={form.lat} onChange={e => setForm({ ...form, lat: e.target.value })} />
            </label>
            <label className="ops-field">
              <span>Start point lng (optional)</span>
              <input type="text" inputMode="decimal" value={form.lng} onChange={e => setForm({ ...form, lng: e.target.value })} />
              <small>Blank = routes start at the farm.</small>
            </label>
          </div>
          <button className="ops-btn ops-btn-primary" type="submit" disabled={busy !== null || !form.name.trim()}>
            {busy === 'add' ? 'Adding…' : 'Add rider'}
          </button>
        </form>
      )}

      {loading ? (
        <p className="ops-pending" role="status">
          Loading riders…
        </p>
      ) : loadError ? (
        <div className="ops-error" role="alert">
          {loadError}
          <div className="ops-actions">
            <button type="button" className="ops-btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        </div>
      ) : (
        <>
          {riders.length === 0 ? (
            <p className="ops-empty">No riders yet.{canEdit ? ' Add one above.' : ''}</p>
          ) : (
            <ul className="ops-list">
              {riders.map(rider => {
                const owned = zones.filter(z => z.riderId === rider.id);
                return (
                  <li key={rider.id}>
                    <div className="ops-card-head">
                      <h3>{rider.name}</h3>
                      <span className={`ops-badge ${rider.active ? 'is-ok' : 'is-warn'}`}>{rider.active ? 'Active' : 'Off'}</span>
                    </div>
                    <dl className="ops-kv" style={{ margin: '0.4rem 0' }}>
                      <dt>Sign-in phone</dt>
                      <dd>{rider.phone ?? <span className="ops-badge is-warn">none — cannot sign in</span>}</dd>
                      <dt>Start point</dt>
                      <dd>
                        {rider.startLocation
                          ? `${rider.startLocation.lat.toFixed(4)}, ${rider.startLocation.lng.toFixed(4)}`
                          : 'farm (default)'}
                      </dd>
                      <dt>Zones</dt>
                      <dd>{owned.length ? owned.map(z => z.name).join(', ') : '—'}</dd>
                    </dl>
                    {canEdit && (
                      <div className="ops-actions">
                        <button
                          type="button"
                          className="ops-btn ops-btn-small"
                          disabled={busy !== null}
                          onClick={() =>
                            void mutate(
                              `act-${rider.id}`,
                              '/api/admin/riders',
                              json('PATCH', { id: rider.id, active: !rider.active }),
                              'Could not update the rider',
                              rider.active ? `${rider.name} is off.` : `${rider.name} is active.`,
                            )
                          }
                        >
                          {busy === `act-${rider.id}` ? 'Saving…' : rider.active ? 'Turn off' : 'Turn on'}
                        </button>
                        <button type="button" className="ops-btn ops-btn-small" disabled={busy !== null} onClick={() => void editPhone(rider)}>
                          {busy === `phone-${rider.id}` ? 'Saving…' : 'Change phone'}
                        </button>
                        <button type="button" className="ops-btn ops-btn-small ops-btn-danger" disabled={busy !== null} onClick={() => void deleteRider(rider)}>
                          {busy === `del-${rider.id}` ? 'Removing…' : 'Remove'}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <h3 style={{ marginTop: '1rem' }}>Who runs each zone</h3>
          {zones.length === 0 ? (
            <p className="ops-empty">No zones yet — draw one on the map below.</p>
          ) : (
            <ul className="ops-list">
              {zones.map(z => (
                <li key={z.id} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>
                    <strong>{z.name}</strong>
                    {!z.active && <span className="ops-badge is-warn"> off</span>}
                  </span>
                  {canEdit ? (
                    <select
                      value={z.riderId ?? ''}
                      disabled={busy !== null}
                      aria-label={`Rider for ${z.name}`}
                      onChange={e =>
                        void mutate(
                          `zone-${z.id}`,
                          '/api/admin/zones',
                          json('PATCH', { id: z.id, riderId: e.target.value === '' ? null : e.target.value }),
                          'Could not assign the zone',
                          `${z.name} updated. Changes apply from the next day that locks.`,
                        )
                      }
                    >
                      <option value="">— unassigned —</option>
                      {riders.map(r => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                          {r.active ? '' : ' (off)'}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span>{riders.find(r => r.id === z.riderId)?.name ?? <span className="ops-badge is-warn">unassigned</span>}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
