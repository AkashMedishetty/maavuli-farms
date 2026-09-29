'use client';

import { useEffect, useRef, useState } from 'react';
import { DEFAULT_CENTRE, roundCoord, samePoint, type EngineProps } from './LocationPickerShared';

/**
 * Google engine — used only when NEXT_PUBLIC_GOOGLE_MAPS_KEY is set.
 *
 * UNTESTED until a key exists: nothing in this environment has a browser key, so
 * this path has been type-checked but never run. Written against Google's current
 * Place Autocomplete (New) widget docs (developers.google.com/maps/documentation/
 * javascript/place-autocomplete-new): PlaceAutocompleteElement with
 * includedRegionCodes, a 'gmp-select' event carrying placePrediction, then
 * placePrediction.toPlace() + place.fetchFields({fields:[...]}). The key needs the
 * Maps JavaScript API and Places API (New) enabled, restricted by HTTP referrer.
 *
 * The draggable marker is the classic google.maps.Marker: AdvancedMarkerElement
 * needs a Map ID, which this project has not created. Google has deprecated the
 * classic Marker (still served); swap it when a Map ID exists.
 */

/* Minimal structural types for what we use (the SDK is loaded at runtime). */
interface GLatLngLiteral { lat: number; lng: number }
interface GLatLng { lat(): number; lng(): number }
interface GMap {
  setCenter(c: GLatLngLiteral): void;
  setZoom(z: number): void;
  getZoom(): number | undefined;
  setMapTypeId(t: string): void;
  fitBounds(b: unknown): void;
  addListener(ev: string, cb: (e: { latLng?: GLatLng | null }) => void): unknown;
}
interface GMarker {
  setPosition(p: GLatLngLiteral): void;
  getPosition(): GLatLng | null | undefined;
  addListener(ev: string, cb: () => void): unknown;
}
interface GPlace {
  displayName?: string | null;
  formattedAddress?: string | null;
  location?: GLatLng | null;
  viewport?: unknown;
  fetchFields(o: { fields: string[] }): Promise<unknown>;
}
interface GSelectEvent extends Event {
  placePrediction?: { toPlace(): GPlace };
}
interface GAutocompleteEl extends HTMLElement {
  includedRegionCodes?: string[];
  locationBias?: unknown;
  placeholder?: string;
}
interface GoogleNS {
  maps: {
    Map: new (el: HTMLElement, o: Record<string, unknown>) => GMap;
    Marker: new (o: Record<string, unknown>) => GMarker;
    importLibrary(name: string): Promise<unknown>;
  };
}

const CALLBACK = '__maavuliGmapsReady';

function loadGoogle(key: string): Promise<GoogleNS> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as { google?: GoogleNS } & Record<string, unknown>;
    if (w.google?.maps?.importLibrary) return resolve(w.google);
    const existing = document.querySelector<HTMLScriptElement>('script[data-gmaps]');
    const prior = w[CALLBACK];
    w[CALLBACK] = () => {
      if (typeof prior === 'function') (prior as () => void)();
      const g = (window as unknown as { google?: GoogleNS }).google;
      if (g) resolve(g);
      else reject(new Error('Google Maps failed to load'));
    };
    if (existing) return;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&libraries=places&loading=async&region=IN&callback=${CALLBACK}`;
    s.async = true;
    s.setAttribute('data-gmaps', '');
    s.onerror = () => reject(new Error('Google Maps failed to load'));
    document.head.appendChild(s);
  });
}

export default function LocationPickerGoogle({ value, onChange, idPrefix, apiKey }: EngineProps & { apiKey: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const searchHolder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GMap | null>(null);
  const markerRef = useRef<GMarker | null>(null);
  const gRef = useRef<GoogleNS | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [satellite, setSatellite] = useState(false);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadGoogle(apiKey)
      .then(async (g) => {
        if (cancelled || !holder.current || mapRef.current) return;
        gRef.current = g;
        const m = new g.maps.Map(holder.current, {
          center: DEFAULT_CENTRE,
          zoom: 12,
          mapTypeId: 'roadmap',
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          gestureHandling: 'cooperative',
        });
        m.addListener('click', (e) => {
          if (!e.latLng) return;
          onChangeRef.current({ lat: roundCoord(e.latLng.lat()), lng: roundCoord(e.latLng.lng()) });
        });
        mapRef.current = m;

        // Place Autocomplete (New) widget — society / building names.
        const places = (await g.maps.importLibrary('places')) as {
          PlaceAutocompleteElement: new (o: Record<string, unknown>) => GAutocompleteEl;
        };
        if (cancelled || !searchHolder.current) return;
        const ac = new places.PlaceAutocompleteElement({ includedRegionCodes: ['in'] });
        ac.locationBias = { center: DEFAULT_CENTRE, radius: 30000 };
        ac.placeholder = 'e.g. Aparna Towers, Safilguda';
        ac.id = `${idPrefix}-search`;
        ac.setAttribute('aria-label', 'Search your society, building or area');
        ac.addEventListener('gmp-select', (ev) => {
          const pred = (ev as GSelectEvent).placePrediction;
          if (!pred) return;
          void (async () => {
            try {
              const place = pred.toPlace();
              await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location', 'viewport'] });
              if (!place.location) {
                setSearchMsg('That place has no exact point. Move the pin by hand.');
                return;
              }
              setSearchMsg(null);
              const label = [place.displayName, place.formattedAddress].filter(Boolean).join(', ');
              onChangeRef.current({
                lat: roundCoord(place.location.lat()),
                lng: roundCoord(place.location.lng()),
                ...(label ? { label } : {}),
              });
            } catch {
              setSearchMsg('The place search is not answering right now. You can still move the pin by hand.');
            }
          })();
        });
        searchHolder.current.appendChild(ac);
        setReady(true);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Google Maps failed to load'));
    return () => {
      cancelled = true;
    };
  }, [apiKey, idPrefix]);

  useEffect(() => {
    mapRef.current?.setMapTypeId(satellite ? 'hybrid' : 'roadmap');
  }, [satellite, ready]);

  useEffect(() => {
    const g = gRef.current;
    const m = mapRef.current;
    if (!ready || !g || !m || !value) return;
    const at = { lat: value.lat, lng: value.lng };
    if (!markerRef.current) {
      const mk = new g.maps.Marker({ position: at, map: m, draggable: true, title: 'Your doorstep — drag to adjust' });
      mk.addListener('dragend', () => {
        const p = mk.getPosition();
        if (p) onChangeRef.current({ lat: roundCoord(p.lat()), lng: roundCoord(p.lng()) });
      });
      markerRef.current = mk;
      m.setCenter(at);
      m.setZoom(Math.max(m.getZoom() ?? 0, 19));
      return;
    }
    const cur = markerRef.current.getPosition();
    if (!cur || !samePoint({ lat: cur.lat(), lng: cur.lng() }, value)) {
      markerRef.current.setPosition(at);
      m.setCenter(at);
      m.setZoom(Math.max(m.getZoom() ?? 0, 19));
    }
  }, [value, ready]);

  return (
    <div className="lp-engine">
      <div className="lp-search">
        {/* The widget is a custom element; it carries its own aria-label (set above). */}
        <span className="lp-label" aria-hidden="true">
          Search your society, building or area
        </span>
        <div ref={searchHolder} className="lp-gsearch" />
      </div>
      {searchMsg ? <p className="lp-msg is-err" role="alert">{searchMsg}</p> : null}
      {loadError ? (
        <p className="lp-msg is-err" role="alert">
          The map could not load ({loadError}). Check your connection and reload the page.
        </p>
      ) : null}
      <div className="lp-maptools">
        <button
          type="button"
          className="lp-btn is-ghost"
          aria-pressed={satellite}
          onClick={() => setSatellite((s) => !s)}
          disabled={!ready}
        >
          {satellite ? 'Show street map' : 'Show satellite'}
        </button>
      </div>
      <div
        ref={holder}
        className="lp-map"
        role="application"
        aria-label="Map. Tap to place your delivery pin, or drag the pin onto your building."
      />
    </div>
  );
}
