'use client';

import { useId, useState } from 'react';
import LocationPickerLeaflet from './LocationPickerLeaflet';
import LocationPickerGoogle from './LocationPickerGoogle';
import { ACCURACY_OK_M, nudge, roundCoord, type PickedLocation } from './LocationPickerShared';
import './LocationPicker.css';

export type { PickedLocation } from './LocationPickerShared';

/**
 * The customer marks their exact doorstep. Output: {lat, lng, accuracyM?, label?}.
 *
 * Engine: Google (Maps JS + Place Autocomplete, satellite toggle) when
 * NEXT_PUBLIC_GOOGLE_MAPS_KEY is set at build time, otherwise Leaflet + OSM with
 * submit-only Nominatim search. Both engines: draggable pin, tap-to-place.
 *
 * Shared here: "use my location" (high accuracy — the customer is told to press it
 * only when standing at the delivery address), the accuracy warning (> 50 m → drag
 * the pin onto your building), and nudge buttons so the pin can be adjusted from a
 * keyboard, since neither map library supports keyboard dragging.
 */

type Geo =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'error'; message: string };

export default function LocationPicker({
  value,
  onChange,
}: {
  value: PickedLocation | null;
  onChange: (v: PickedLocation) => void;
}) {
  const idPrefix = `lp${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [geo, setGeo] = useState<Geo>({ kind: 'idle' });
  // NEXT_PUBLIC_* is inlined at build time; reading it in render is the documented way.
  const googleKey = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? '').trim();

  function locateMe() {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGeo({ kind: 'error', message: 'This browser cannot share a location. Search or move the pin instead.' });
      return;
    }
    setGeo({ kind: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ kind: 'idle' });
        onChange({
          lat: roundCoord(pos.coords.latitude),
          lng: roundCoord(pos.coords.longitude),
          accuracyM: Math.round(pos.coords.accuracy),
        });
      },
      (err) => {
        const message =
          err.code === err.PERMISSION_DENIED
            ? 'Location access was declined. That is fine — search for your building or move the pin by hand.'
            : err.code === err.POSITION_UNAVAILABLE
              ? 'Your phone could not get a location fix. Search for your building or move the pin by hand.'
              : 'Finding your location took too long. Try again, or move the pin by hand.';
        setGeo({ kind: 'error', message });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  // A dragged / nudged / tapped pin is a deliberate choice: it has no GPS accuracy.
  const move = (northM: number, eastM: number) => {
    if (!value) return;
    const p = nudge(value, northM, eastM);
    onChange({ ...p, ...(value.label ? { label: value.label } : {}) });
  };

  const inaccurate = value?.accuracyM !== undefined && value.accuracyM > ACCURACY_OK_M;

  return (
    <div className="lp">
      <div className="lp-geo">
        <button
          type="button"
          className="lp-btn is-primary"
          onClick={locateMe}
          disabled={geo.kind === 'locating'}
        >
          {geo.kind === 'locating' ? (
            <>
              <span className="lp-spinner" aria-hidden="true" /> Finding you…
            </>
          ) : (
            'I am at the delivery address — use my location'
          )}
        </button>
        <p className="lp-help">Only press this while standing at the door we should deliver to.</p>
        {geo.kind === 'error' ? (
          <p className="lp-msg is-err" role="alert">{geo.message}</p>
        ) : null}
      </div>

      {googleKey ? (
        <LocationPickerGoogle value={value} onChange={onChange} idPrefix={idPrefix} apiKey={googleKey} />
      ) : (
        <LocationPickerLeaflet value={value} onChange={onChange} idPrefix={idPrefix} />
      )}

      <div className="lp-status" aria-live="polite">
        {value ? (
          <>
            {inaccurate ? (
              <p className="lp-msg is-warn">
                Your phone places you within about {value.accuracyM} m — not close enough to find
                your door. Please drag the pin onto your building.
              </p>
            ) : value.accuracyM !== undefined ? (
              <p className="lp-msg is-ok">Pinned to within about {value.accuracyM} m. Drag the pin if it is not on your building.</p>
            ) : (
              <p className="lp-msg">Pin placed. Drag it if it is not exactly on your building.</p>
            )}
            {value.label ? <p className="lp-help">Near: {value.label}</p> : null}
          </>
        ) : (
          <p className="lp-help">No pin yet — use your location, search, or tap the map.</p>
        )}
      </div>

      {value ? (
        <fieldset className="lp-nudge">
          <legend>Fine-tune the pin (about 5 m per press)</legend>
          <button type="button" className="lp-btn is-ghost" onClick={() => move(5, 0)} aria-label="Move pin north">↑</button>
          <button type="button" className="lp-btn is-ghost" onClick={() => move(0, -5)} aria-label="Move pin west">←</button>
          <button type="button" className="lp-btn is-ghost" onClick={() => move(0, 5)} aria-label="Move pin east">→</button>
          <button type="button" className="lp-btn is-ghost" onClick={() => move(-5, 0)} aria-label="Move pin south">↓</button>
        </fieldset>
      ) : null}
    </div>
  );
}
