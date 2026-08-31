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

export default function ZoneMap() {
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

  const refresh = useCallback(async () => {
    const r = await fetch('/api/admin/zones');
    if (r.status === 403) { setMsg('Your mobile is not in ADMIN_MOBILES.'); return; }
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      setMsg(b.missing ? `Not configured: ${b.missing.join(', ')}` : 'Could not load zones.');
      return;
    }
    const b = (await r.json()) as { zones: ZoneRow[] };
    setZones(b.zones);
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
        m.on('click', (e: { latlng: { lat: number; lng: number } }) => {
          setCentre({ lat: e.latlng.lat, lng: e.latlng.lng });
        });
        map.current = m;
        setReady(true);
      })
      .catch(e => setLoadError(e instanceof Error ? e.message : 'Leaflet failed to load'));
    return () => { cancelled = true; };
  }, []);

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
    setMsg(null);
    try {
      const r = await fetch('/api/admin/zones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), lat: centre.lat, lng: centre.lng, radiusM }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(b.error ?? 'Could not save the zone.'); return; }
      setName('');
      setCentre(null);
      await refresh();
      setMsg(`Saved “${b.name}”.`);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(z: ZoneRow) {
    await fetch('/api/admin/zones', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: z.id, active: !z.active }),
    });
    await refresh();
  }

  async function remove(z: ZoneRow) {
    await fetch(`/api/admin/zones?id=${encodeURIComponent(z.id)}`, { method: 'DELETE' });
    await refresh();
  }

  const activeCount = zones.filter(z => z.active).length;

  return (
    <section className="zone-editor">
      <div className="zone-head">
        <h2>Delivery zones</h2>
        <p className="zone-state">
          {activeCount === 0
            ? 'No active zone — serviceability is fail-closed, so we currently deliver nowhere.'
            : `${activeCount} active zone${activeCount === 1 ? '' : 's'}.`}
        </p>
      </div>

      {loadError ? (
        <p className="zone-msg">
          The map could not load ({loadError}). Zones can still be managed from the list below;
          the map is a convenience for picking a centre, not the source of truth.
        </p>
      ) : null}

      <div ref={holder} className="zone-map" role="application" aria-label="Delivery zone map" />

      <div className="zone-form">
        <p className="zone-hint">
          {centre
            ? `Centre ${centre.lat.toFixed(5)}, ${centre.lng.toFixed(5)} — adjust the radius, name it, then save.`
            : 'Click the map to place a zone centre.'}
        </p>
        <label>
          <span>Zone name</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Safilguda morning round"
            maxLength={80}
          />
        </label>
        <label>
          <span>Radius — {(radiusM / 1000).toFixed(1)} km</span>
          <input
            type="range"
            min={200}
            max={25000}
            step={100}
            value={radiusM}
            onChange={e => setRadiusM(Number(e.target.value))}
          />
        </label>
        <button className="cta" onClick={save} disabled={busy || !centre || !name.trim()}>
          {busy ? 'Saving…' : 'Save zone'}
        </button>
        {msg ? <p className="zone-msg">{msg}</p> : null}
      </div>

      {zones.length > 0 ? (
        <ul className="zone-list">
          {zones.map(z => (
            <li key={z.id}>
              <span className="zone-name">{z.name}</span>
              <span className="zone-shape">
                {z.shape.kind === 'circle'
                  ? `${(z.shape.radiusM / 1000).toFixed(1)} km circle`
                  : `${z.shape.points.length}-point area`}
              </span>
              <button onClick={() => toggle(z)}>{z.active ? 'Turn off' : 'Turn on'}</button>
              <button onClick={() => remove(z)}>Delete</button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
