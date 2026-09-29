'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Delivery-zone editor on a Leaflet map with OpenStreetMap tiles.
 *
 * WHY LEAFLET + OSM: no API key, no billing account, no per-load quota. Google
 * Maps would need a billed key wired into the client before an admin could draw a
 * single circle. OSM's tile policy is fine for an internal panel like this; if zone
 * editing ever became high-traffic the tile URL is the one line to swap.
 *
 * WHY CDN RATHER THAN A DEPENDENCY: this loads a pinned 1.9.4 with real subresource
 * integrity hashes (computed from the actual files, not remembered), so a
 * compromised or swapped CDN artefact simply fails to execute. It can be moved to a
 * bundled dependency later without touching this component's logic.
 *
 * The map only ever CAPTURES intent — a centre and a radius. The authoritative
 * GeoJSON is derived server-side in the zones route, because a ring wound the wrong
 * way makes MongoDB match the complement of the zone, i.e. everywhere on Earth
 * except the area you drew. That failure mode fails open, so the client is not
 * trusted to produce geometry.
 */

const LEAFLET_VERSION = '1.9.4';
const CSS_URL = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const JS_URL = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const CSS_SRI = 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H';
const JS_SRI = 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH';

/** Secunderabad, near the farm's stated address. Only the initial map centre. */
const DEFAULT_CENTRE: [number, number] = [17.4735, 78.5468];

interface ZoneRow {
  id: string;
  name: string;
  active: boolean;
  shape:
    | { kind: 'circle'; centre: { lat: number; lng: number }; radiusM: number }
    | { kind: 'polygon'; points: { lat: number; lng: number }[] };
  note: string | null;
}

// Leaflet is loaded at runtime from a CDN, so it has no compile-time types here.
/* eslint-disable @typescript-eslint/no-explicit-any */
type L = any;

function loadLeaflet(): Promise<L> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as { L?: L };
    if (w.L) return resolve(w.L);

    if (!document.querySelector(`link[data-leaflet]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_URL;
      link.integrity = CSS_SRI;
      link.crossOrigin = 'anonymous';
      link.setAttribute('data-leaflet', '');
      document.head.appendChild(link);
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-leaflet]');
    if (existing) {
      existing.addEventListener('load', () => resolve((window as unknown as { L: L }).L));
      existing.addEventListener('error', () => reject(new Error('Leaflet failed to load')));
      return;
    }

    const s = document.createElement('script');
    s.src = JS_URL;
    s.integrity = JS_SRI;
    s.crossOrigin = 'anonymous';
    s.async = true;
    s.setAttribute('data-leaflet', '');
    s.onload = () => resolve((window as unknown as { L: L }).L);
    s.onerror = () => reject(new Error('Leaflet failed to load'));
    document.head.appendChild(s);
  });
}

export default function ZoneMap({ canEdit = true, onChange }: { canEdit?: boolean; onChange?: () => void } = {}) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<L>(null);
  const drawn = useRef<L[]>([]);
  const preview = useRef<L>(null);

  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [centre, setCentre] = useState<{ lat: number; lng: number } | null>(null);
  const [radiusM, setRadiusM] = useState(3000);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [listState, setListState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [listError, setListError] = useState<string | null>(null);

  const say = (text: string | null, error = false) => {
    setMsg(text);
    setIsError(error);
  };

  // Typed centre (for when the map is down, and for keyboard / screen-reader users).
  const [latText, setLatText] = useState('');
  const [lngText, setLngText] = useState('');
  const typeCentre = (lat: string, lng: string) => {
    setLatText(lat);
    setLngText(lng);
    const la = Number(lat);
    const ln = Number(lng);
    const ok = lat.trim() !== '' && lng.trim() !== '' && Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180;
    setCentre(ok ? { lat: la, lng: ln } : null);
  };

  /** The API's error plus its field issues (§9), as RidersPanel does. */
  const errorText = (b: { error?: unknown; issues?: unknown }, fallback: string) => {
    const base = typeof b.error === 'string' ? b.error : fallback;
    const issues = Array.isArray(b.issues) ? b.issues.filter((i): i is string => typeof i === 'string') : [];
    return issues.length ? `${base}: ${issues.join('; ')}` : base;
  };

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/zones', { cache: 'no-store' });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string; missing?: string[] };
        setListError(b.missing ? `Not configured: ${b.missing.join(', ')}` : (b.error ?? `Could not load zones (HTTP ${r.status}).`));
        setListState('error');
        return;
      }
      const b = (await r.json()) as { zones: ZoneRow[] };
      setZones(b.zones);
      setListState('ready');
    } catch {
      setListError('Could not load zones: the network request did not complete.');
      setListState('error');
    }
  }, []);

  /* ---- boot the map ---- */
  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then(Lf => {
        if (cancelled || !holder.current || map.current) return;
        const m = Lf.map(holder.current).setView(DEFAULT_CENTRE, 12);
        Lf.tileLayer(`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`, {
          maxZoom: 19,
          // Attribution is REQUIRED by the OSM tile usage policy, not decoration.
          attribution: '&copy; OpenStreetMap contributors',
        }).addTo(m);
        if (canEdit) {
          m.on('click', (e: { latlng: { lat: number; lng: number } }) => {
            setCentre({ lat: e.latlng.lat, lng: e.latlng.lng });
            setLatText(e.latlng.lat.toFixed(5));
            setLngText(e.latlng.lng.toFixed(5));
          });
        }
        map.current = m;
        setReady(true);
      })
      .catch(e => setLoadError(e instanceof Error ? e.message : 'Leaflet failed to load'));
    return () => { cancelled = true; };
  }, [canEdit]);

  useEffect(() => { void refresh(); }, [refresh]);

  /* ---- draw saved zones ---- */
  useEffect(() => {
    const w = window as unknown as { L?: L };
    const m = map.current;
    if (!ready || !m || !w.L) return;
    const Lf = w.L;

    for (const layer of drawn.current) m.removeLayer(layer);
    drawn.current = [];

    for (const z of zones) {
      const style = {
        color: z.active ? '#8c170e' : '#9a9a9a',
        weight: 2,
        fillOpacity: z.active ? 0.12 : 0.05,
      };
      const layer =
        z.shape.kind === 'circle'
          ? Lf.circle([z.shape.centre.lat, z.shape.centre.lng], { ...style, radius: z.shape.radiusM })
          : Lf.polygon(z.shape.points.map(p => [p.lat, p.lng]), style);
      layer.bindTooltip(`${z.name}${z.active ? '' : ' (off)'}`);
      layer.addTo(m);
      drawn.current.push(layer);
    }
  }, [zones, ready]);

  /* ---- live preview of the circle being placed ---- */
  useEffect(() => {
    const w = window as unknown as { L?: L };
    const m = map.current;
    if (!ready || !m || !w.L) return;
    if (preview.current) { m.removeLayer(preview.current); preview.current = null; }
    if (!centre) return;
    preview.current = w.L
      .circle([centre.lat, centre.lng], {
        radius: radiusM,
        color: '#8c170e',
        dashArray: '6 6',
        weight: 2,
        fillOpacity: 0.06,
      })
      .addTo(m);
  }, [centre, radiusM, ready]);

  async function save() {
    if (!centre || !name.trim()) return;
    setBusy(true);
    say(null);
    try {
      const r = await fetch('/api/admin/zones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), lat: centre.lat, lng: centre.lng, radiusM }),
      });
      const b = (await r.json().catch(() => ({}))) as { error?: string; issues?: unknown; name?: string };
      if (!r.ok) { say(errorText(b, `Could not save the zone (HTTP ${r.status}).`), true); return; }
      setName('');
      setCentre(null);
      setLatText('');
      setLngText('');
      await refresh();
      onChange?.();
      say(`Saved “${b.name ?? name.trim()}”. Give it a rider in the list above.`);
    } catch {
      say('Could not save the zone: the network request did not complete.', true);
    } finally {
      setBusy(false);
    }
  }

  async function mutateZone(url: string, init: RequestInit, fallback: string, success: string) {
    setBusy(true);
    say(null);
    try {
      const r = await fetch(url, init);
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string; issues?: unknown };
        say(errorText(b, `${fallback} (HTTP ${r.status}).`), true);
        return;
      }
      await refresh();
      onChange?.();
      say(success);
    } catch {
      say(`${fallback}: the network request did not complete.`, true);
    } finally {
      setBusy(false);
    }
  }

  function toggle(z: ZoneRow) {
    void mutateZone(
      '/api/admin/zones',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: z.id, active: !z.active }) },
      'Could not update the zone',
      z.active ? `${z.name} is off — its addresses are no longer serviceable.` : `${z.name} is on.`,
    );
  }

  function remove(z: ZoneRow) {
    if (!window.confirm(`Delete zone "${z.name}"? New customers there can no longer subscribe. Turning it off is reversible; deleting is not.`)) return;
    void mutateZone(`/api/admin/zones?id=${encodeURIComponent(z.id)}`, { method: 'DELETE' }, 'Could not delete the zone', `Deleted ${z.name}.`);
  }

  const activeCount = zones.filter(z => z.active).length;

  return (
    <section className="ops-card zone-editor" aria-labelledby="zones-h">
      <div className="ops-card-head">
        <h2 id="zones-h">Delivery zones</h2>
        {listState === 'ready' && (
          <span className={`ops-badge ${activeCount === 0 ? 'is-bad' : 'is-ok'}`}>
            {activeCount} active
          </span>
        )}
      </div>
      {listState === 'ready' && activeCount === 0 && (
        <p className="ops-warn">No active zone — serviceability fails closed, so we currently deliver nowhere.</p>
      )}

      {loadError ? (
        <p className="ops-warn">
          The map could not load ({loadError}). Existing zones can still be turned on/off or deleted below
          {canEdit ? ', and a new zone can be added by typing its centre latitude and longitude' : ''}.
        </p>
      ) : null}

      <div ref={holder} className="zone-map" role="application" aria-label="Delivery zone map (or type the centre below)" />

      {canEdit && (
        <div className="ops-card" style={{ background: 'var(--ops-soft)' }}>
          <h3>Add a zone</h3>
          <p className="ops-muted">
            {centre
              ? `Centre ${centre.lat.toFixed(5)}, ${centre.lng.toFixed(5)} — adjust the radius, name it, then save.`
              : 'Tap the map to place a zone centre, or type its latitude and longitude.'}
          </p>
          <div className="ops-form-grid">
            <label className="ops-field">
              <span>Centre latitude</span>
              <input type="text" inputMode="decimal" autoComplete="off" value={latText} onChange={e => typeCentre(e.target.value, lngText)} placeholder="e.g. 17.47350" />
            </label>
            <label className="ops-field">
              <span>Centre longitude</span>
              <input type="text" inputMode="decimal" autoComplete="off" value={lngText} onChange={e => typeCentre(latText, e.target.value)} placeholder="e.g. 78.54680" />
            </label>
          </div>
          <label className="ops-field">
            <span>Zone name</span>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Safilguda morning round" maxLength={80} />
          </label>
          <label className="ops-field">
            <span>Radius — {(radiusM / 1000).toFixed(1)} km</span>
            <input type="range" min={200} max={25000} step={100} value={radiusM} onChange={e => setRadiusM(Number(e.target.value))} />
          </label>
          <button type="button" className="ops-btn ops-btn-primary" onClick={save} disabled={busy || !centre || !name.trim()}>
            {busy ? 'Saving…' : 'Save zone'}
          </button>
        </div>
      )}

      {msg ? (
        <p className={isError ? 'ops-error' : 'ops-ok'} role={isError ? 'alert' : 'status'}>
          {msg}
        </p>
      ) : null}

      {listState === 'loading' ? (
        <p className="ops-pending" role="status">
          Loading zones…
        </p>
      ) : listState === 'error' ? (
        <div className="ops-error" role="alert">
          {listError}
          <div className="ops-actions">
            <button type="button" className="ops-btn" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        </div>
      ) : zones.length === 0 ? (
        <p className="ops-empty">No zones yet.</p>
      ) : (
        <ul className="ops-list">
          {zones.map(z => (
            <li key={z.id}>
              <div className="ops-card-head">
                <strong>{z.name}</strong>
                <span className={`ops-badge ${z.active ? 'is-ok' : 'is-warn'}`}>{z.active ? 'On' : 'Off'}</span>
              </div>
              <p className="ops-muted" style={{ margin: '0.2rem 0' }}>
                {z.shape.kind === 'circle' ? `${(z.shape.radiusM / 1000).toFixed(1)} km circle` : `${z.shape.points.length}-point area`}
                {z.note ? ` · ${z.note}` : ''}
              </p>
              {canEdit && (
                <div className="ops-actions">
                  <button type="button" className="ops-btn ops-btn-small" onClick={() => toggle(z)} disabled={busy}>
                    {z.active ? 'Turn off' : 'Turn on'}
                  </button>
                  <button type="button" className="ops-btn ops-btn-small ops-btn-danger" onClick={() => remove(z)} disabled={busy}>
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
