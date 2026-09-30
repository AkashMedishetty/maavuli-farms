'use client';

import { useEffect, useRef, useState } from 'react';
import { DEFAULT_CENTRE, roundCoord, samePoint, type EngineProps } from './LocationPickerShared';

/**
 * Leaflet + OpenStreetMap engine (used when NEXT_PUBLIC_GOOGLE_MAPS_KEY is not set).
 *
 * Loads the SAME pinned Leaflet 1.9.4 with the SAME subresource-integrity hashes as
 * components/ZoneMap.tsx, so a swapped CDN artefact fails to execute. The two share
 * one <script data-leaflet> tag when both are on a page.
 *
 * Search goes to OSM Nominatim, and only when the customer SUBMITS the search box.
 * Their usage policy forbids autocomplete and caps us at 1 request/second, so this
 * never fires per keystroke and a second submit within 1 s waits its turn.
 *
 * The marker is a divIcon (pure CSS), which avoids Leaflet's default icon images —
 * those would be extra un-integrity-checked downloads.
 */

const LEAFLET_VERSION = '1.9.4';
const CSS_URL = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const JS_URL = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const CSS_SRI = 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H';
const JS_SRI = 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
/** A loose box around Hyderabad/Secunderabad — biases, does not restrict, results. */
const VIEWBOX = '78.10,17.75,78.95,17.15';

/* Minimal structural types for the parts of Leaflet we touch (loaded at runtime). */
interface LLatLng { lat: number; lng: number }
interface LMarker {
  setLatLng(p: [number, number]): LMarker;
  getLatLng(): LLatLng;
  addTo(m: LMap): LMarker;
  on(ev: string, cb: () => void): LMarker;
}
interface LMap {
  setView(c: [number, number], z: number): LMap;
  getZoom(): number;
  on(ev: string, cb: (e: { latlng: LLatLng }) => void): LMap;
  remove(): void;
}
interface LeafletNS {
  map(el: HTMLElement, opts?: Record<string, unknown>): LMap;
  tileLayer(url: string, opts: Record<string, unknown>): { addTo(m: LMap): unknown };
  marker(p: [number, number], opts: Record<string, unknown>): LMarker;
  divIcon(opts: Record<string, unknown>): unknown;
}

function loadLeaflet(): Promise<LeafletNS> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as { L?: LeafletNS };
    if (w.L) return resolve(w.L);
    if (!document.querySelector('link[data-leaflet]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_URL;
      link.integrity = CSS_SRI;
      link.crossOrigin = 'anonymous';
      link.setAttribute('data-leaflet', '');
      document.head.appendChild(link);
    }
    const done = () => {
      const L = (window as unknown as { L?: LeafletNS }).L;
      if (L) resolve(L);
      else reject(new Error('Leaflet failed to load'));
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-leaflet]');
    if (existing) {
      existing.addEventListener('load', done);
      existing.addEventListener('error', () => reject(new Error('Leaflet failed to load')));
      return;
    }
    const s = document.createElement('script');
    s.src = JS_URL;
    s.integrity = JS_SRI;
    s.crossOrigin = 'anonymous';
    s.async = true;
    s.setAttribute('data-leaflet', '');
    s.onload = done;
    s.onerror = () => reject(new Error('Leaflet failed to load'));
    document.head.appendChild(s);
  });
}

interface NominatimHit {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

type Search =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  | { kind: 'results'; hits: NominatimHit[] };

export default function LocationPickerLeaflet({ value, onChange, idPrefix }: EngineProps) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LMap | null>(null);
  const markerRef = useRef<LMarker | null>(null);
  const LRef = useRef<LeafletNS | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastSearchAt = useRef(0);

  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState<Search>({ kind: 'idle' });

  /* ---- boot ---- */
  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((L) => {
        if (cancelled || !holder.current || mapRef.current) return;
        LRef.current = L;
        const m = L.map(holder.current, { tap: true }).setView([DEFAULT_CENTRE.lat, DEFAULT_CENTRE.lng], 12);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          // Required by the OSM tile policy — not decoration.
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(m);
        // A tap on the map moves the pin there — easier than dragging on a small phone.
        m.on('click', (e) => {
          onChangeRef.current({ lat: roundCoord(e.latlng.lat), lng: roundCoord(e.latlng.lng) });
        });
        mapRef.current = m;
        setReady(true);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Leaflet failed to load'));
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  /* ---- keep the marker on `value` ---- */
  useEffect(() => {
    const L = LRef.current;
    const m = mapRef.current;
    if (!ready || !L || !m || !value) return;
    const at: [number, number] = [value.lat, value.lng];
    if (!markerRef.current) {
      const icon = L.divIcon({
        className: 'lp-pin',
        html: '<span class="lp-pin-head"></span>',
        iconSize: [30, 42],
        iconAnchor: [15, 42],
      });
      const mk = L.marker(at, { draggable: true, autoPan: true, icon, title: 'Your doorstep — drag to adjust', alt: 'Delivery marker' }).addTo(m);
      mk.on('dragend', () => {
        const p = mk.getLatLng();
        onChangeRef.current({ lat: roundCoord(p.lat), lng: roundCoord(p.lng) });
      });
      markerRef.current = mk;
      m.setView(at, Math.max(m.getZoom(), 18));
      return;
    }
    const cur = markerRef.current.getLatLng();
    if (!samePoint(cur, value)) {
      markerRef.current.setLatLng(at);
      m.setView(at, Math.max(m.getZoom(), 18));
    }
  }, [value, ready]);

  // Not a <form>: this picker is rendered INSIDE the account address form, and a
  // nested form is invalid HTML (dropped by the parser, and Enter/Search would
  // submit the outer address form). A search landmark + button + Enter handler.
  async function runSearch() {
    const text = q.trim();
    if (text.length < 3 || search.kind === 'busy') return;
    setSearch({ kind: 'busy' });
    // Nominatim policy: at most one request per second.
    const wait = 1000 - (Date.now() - lastSearchAt.current);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSearchAt.current = Date.now();
    try {
      const url = `${NOMINATIM}?format=json&countrycodes=in&limit=5&accept-language=en&viewbox=${VIEWBOX}&q=${encodeURIComponent(text)}`;
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        setSearch({ kind: 'error', message: 'The map search is not answering right now. You can still tap your building on the map.' });
        return;
      }
      const hits = (await res.json()) as NominatimHit[];
      setSearch({ kind: 'results', hits: Array.isArray(hits) ? hits : [] });
    } catch {
      setSearch({ kind: 'error', message: 'The map search is not answering right now. You can still tap your building on the map.' });
    }
  }

  function pick(h: NominatimHit) {
    const lat = Number(h.lat);
    const lng = Number(h.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    onChange({ lat: roundCoord(lat), lng: roundCoord(lng), label: h.display_name });
    setSearch({ kind: 'idle' });
  }

  const inputId = `${idPrefix}-search`;
  return (
    <div className="lp-engine">
      <div className="lp-search" role="search">
        <label htmlFor={inputId} className="lp-label">
          Search your society, building or area
        </label>
        <div className="lp-search-row">
          <input
            id={inputId}
            className="lp-input"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. Aparna Towers, Safilguda"
            autoComplete="off"
            maxLength={120}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault(); // never submit an enclosing form
              void runSearch();
            }}
          />
          <button type="button" className="lp-btn" onClick={() => void runSearch()} disabled={q.trim().length < 3 || search.kind === 'busy'}>
            {search.kind === 'busy' ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {search.kind === 'error' ? (
        <p className="lp-msg is-err" role="alert">{search.message}</p>
      ) : null}
      {search.kind === 'results' ? (
        search.hits.length === 0 ? (
          <p className="lp-msg" role="status">
            No match on the map for that. Try the area name, or tap your building on the map.
          </p>
        ) : (
          <ul className="lp-results" aria-label="Search results">
            {search.hits.map((h) => (
              <li key={h.place_id}>
                <button type="button" onClick={() => pick(h)}>{h.display_name}</button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {loadError ? (
        <p className="lp-msg is-err" role="alert">
          The map could not load ({loadError}). Check your connection and reload the page.
        </p>
      ) : null}
      <div
        ref={holder}
        className="lp-map"
        role="application"
        aria-label="Map. Tap your building to mark it, or drag the marker onto your building."
      />
      <p className="lp-attrib">
        Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors · search by Nominatim
      </p>
    </div>
  );
}
