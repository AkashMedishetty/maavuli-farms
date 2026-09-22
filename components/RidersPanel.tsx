'use client';

import { useEffect, useState } from 'react';

/**
 * Admin: riders and which zone each one runs.
 *
 * The route planner (lib/admin.planRoutes) buckets each day's stops by the zone
 * they fall in and that zone's rider, so this panel is where the two are wired
 * together: create riders, and assign a rider to each delivery zone. Everything
 * here is admin-gated at the API — this component only renders inside the
 * server-gated admin page, and every write goes through /api/admin/*.
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

export default function RidersPanel() {
  const [riders, setRiders] = useState<Rider[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', lat: '', lng: '' });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [rr, zr] = await Promise.all([fetch('/api/admin/riders'), fetch('/api/admin/zones')]);
      if (!rr.ok) throw new Error((await rr.json().catch(() => ({}))).error || 'Could not load riders.');
      if (!zr.ok) throw new Error((await zr.json().catch(() => ({}))).error || 'Could not load zones.');
      const rb = (await rr.json()) as { riders: Rider[] };
      const zb = (await zr.json()) as { zones: Zone[] };
      setRiders(rb.riders ?? []);
      setZones(zb.zones ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const addRider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { name: form.name.trim() };
      if (form.phone.trim()) body.phone = form.phone.trim();
      if (form.lat.trim() && form.lng.trim()) {
        body.lat = form.lat.trim();
        body.lng = form.lng.trim();
      }
      const r = await fetch('/api/admin/riders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not add rider.');
      setForm({ name: '', phone: '', lat: '', lng: '' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add rider.');
    } finally {
      setBusy(false);
    }
  };

  const patchRider = async (id: string, patch: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/riders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...patch }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not update rider.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update rider.');
    } finally {
      setBusy(false);
    }
  };

  const deleteRider = async (id: string, name: string) => {
    if (!window.confirm(`Remove rider "${name}"? Their zones become unassigned.`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/admin/riders?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not remove rider.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove rider.');
    } finally {
      setBusy(false);
    }
  };

  const assignZone = async (zoneId: string, riderId: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/zones', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: zoneId, riderId: riderId === '' ? null : riderId }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not assign zone.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not assign zone.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-section riders-panel">
      <h2>Riders &amp; zones</h2>
      <p className="riders-lead">
        Create your riders, then hand each delivery zone to one of them. The route planner below
        splits the day&rsquo;s stops by zone and sequences each rider&rsquo;s run.
      </p>

      {error && <p className="riders-error">{error}</p>}

      <form className="riders-form" onSubmit={addRider}>
        <input
          type="text"
          placeholder="Rider name"
          value={form.name}
          onChange={e => setForm({ ...form, name: e.target.value })}
          required
        />
        <input
          type="tel"
          placeholder="Phone (optional)"
          value={form.phone}
          onChange={e => setForm({ ...form, phone: e.target.value })}
        />
        <input
          type="text"
          inputMode="decimal"
          placeholder="Start lat (optional)"
          value={form.lat}
          onChange={e => setForm({ ...form, lat: e.target.value })}
        />
        <input
          type="text"
          inputMode="decimal"
          placeholder="Start lng (optional)"
          value={form.lng}
          onChange={e => setForm({ ...form, lng: e.target.value })}
        />
        <button className="cta" type="submit" disabled={busy || !form.name.trim()}>
          Add rider
        </button>
      </form>

      {loading ? (
        <p className="pending">Loading riders…</p>
      ) : (
        <>
          {riders.length === 0 ? (
            <p className="pending">No riders yet. Add one above.</p>
          ) : (
            <div className="plan-table riders-list">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Rider</th>
                    <th scope="col">Phone</th>
                    <th scope="col">Start point</th>
                    <th scope="col">Zones</th>
                    <th scope="col">Status</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {riders.map(rider => {
                    const owned = zones.filter(z => z.riderId === rider.id);
                    return (
                      <tr key={rider.id}>
                        <th scope="row">{rider.name}</th>
                        <td>{rider.phone ?? '—'}</td>
                        <td>
                          {rider.startLocation
                            ? `${rider.startLocation.lat.toFixed(4)}, ${rider.startLocation.lng.toFixed(4)}`
                            : 'farm default'}
                        </td>
                        <td>{owned.length ? owned.map(z => z.name).join(', ') : '—'}</td>
                        <td>
                          <span className={`admin-status is-${rider.active ? 'delivered' : 'skipped'}`}>
                            {rider.active ? 'active' : 'off'}
                          </span>
                        </td>
                        <td className="riders-actions">
                          <button
                            type="button"
                            onClick={() => patchRider(rider.id, { active: !rider.active })}
                            disabled={busy}
                          >
                            {rider.active ? 'Turn off' : 'Turn on'}
                          </button>
                          <button
                            type="button"
                            className="riders-danger"
                            onClick={() => deleteRider(rider.id, rider.name)}
                            disabled={busy}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="riders-subhead">Zone assignment</h3>
          {zones.length === 0 ? (
            <p className="pending">No zones yet — draw delivery zones on the map above first.</p>
          ) : (
            <ul className="riders-zones">
              {zones.map(z => (
                <li key={z.id}>
                  <span className="riders-zone-name">
                    {z.name}
                    {!z.active && <em> (off)</em>}
                  </span>
                  <select
                    value={z.riderId ?? ''}
                    onChange={e => assignZone(z.id, e.target.value)}
                    disabled={busy}
                    aria-label={`Rider for ${z.name}`}
                  >
                    <option value="">— unassigned —</option>
                    {riders.map(r => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                        {r.active ? '' : ' (off)'}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
