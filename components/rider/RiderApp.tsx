'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cacheToday,
  enqueueAction,
  newActionId,
  queueCount,
  readCachedToday,
  type QueuedAction,
} from './queue';
import { apiCloseRun, apiStartRun, compressImage, flushQueue, getPosition } from './sync';

/* ------------------------------------------------------------------ types --- */

interface StopItem {
  deliveryId: string;
  kind: 'cow' | 'buffalo';
  litres: number;
  source: 'plan' | 'makeup' | 'extra';
  status: string;
}
interface Stop {
  stopKey: string;
  seq: number;
  mobile: string;
  name: string;
  address: string;
  landmark?: string;
  instructions?: string;
  location?: { lat: number; lng: number };
  navUrl?: string;
  items: StopItem[];
  done: boolean;
}
interface Today {
  date: string;
  hasRun: boolean;
  runId: string | null;
  status: 'none' | 'planned' | 'in_progress' | 'completed' | 'closed';
  window: { start: string; end: string };
  stops: Stop[];
  navigationBatches: string[];
  progress: { total: number; done: number };
  load: { cowLitres: number; buffaloLitres: number; stops: number };
  rider?: { id: string; name: string | null };
}

/** Reason chips shown to the rider. Telugu labels are flagged pending native review. */
const REASONS: { code: string; en: string; te: string; fault: 'ours' | 'customer' }[] = [
  { code: 'no_access', en: 'No access / gate locked', te: 'ప్రవేశం లేదు', fault: 'customer' },
  { code: 'refused', en: 'Customer refused', te: 'నిరాకరించారు', fault: 'customer' },
  { code: 'customer_asked_skip', en: 'Asked to skip today', te: 'ఈరోజు వద్దు అన్నారు', fault: 'customer' },
  { code: 'could_not_find', en: 'Could not find address', te: 'చిరునామా దొరకలేదు', fault: 'customer' },
  { code: 'out_of_stock', en: 'Ran out of stock', te: 'స్టాక్ అయిపోయింది', fault: 'ours' },
  { code: 'spoiled', en: 'Milk spoiled', te: 'పాలు పాడయ్యాయి', fault: 'ours' },
  { code: 'vehicle_issue', en: 'Vehicle problem', te: 'వాహన సమస్య', fault: 'ours' },
  { code: 'other', en: 'Other', te: 'ఇతర', fault: 'ours' },
];

/* ---------------------------------------------------------------- component -- */

export default function RiderApp({ riderName }: { riderName: string | null }) {
  const [today, setToday] = useState<Today | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Stop | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/rider/today', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not load your round (${res.status})`);
      }
      const data = (await res.json()) as Today;
      setToday(data);
      await cacheToday(data);
    } catch (e) {
      // Offline / server down: fall back to the last cached round, honestly labelled.
      const cached = (await readCachedToday()) as Today | null;
      if (cached) {
        setToday(cached);
        setError('Showing your last saved round — you appear to be offline.');
      } else {
        setError(e instanceof Error ? e.message : 'Could not load your round.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshPending = useCallback(async () => {
    try {
      setPending(await queueCount());
    } catch {
      /* IndexedDB unavailable (private mode) — the app still works online */
    }
  }, []);

  // Periodic flush + connectivity tracking.
  useEffect(() => {
    void load();
    void refreshPending();
    const online = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', off);
    const timer = setInterval(async () => {
      const { flushed, remaining } = await flushQueue();
      setPending(remaining);
      if (flushed > 0) void load();
    }, 15_000);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', off);
      clearInterval(timer);
    };
  }, [load, refreshPending]);

  async function onStart() {
    setBusy('start');
    try {
      await apiStartRun();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the run.');
    } finally {
      setBusy(null);
    }
  }

  async function queueOutcome(a: QueuedAction) {
    await enqueueAction(a);
    await refreshPending();
    // optimistic: mark the stop done locally
    setToday(t =>
      t
        ? {
            ...t,
            stops: t.stops.map(s =>
              s.items.some(i => i.deliveryId === a.deliveryId)
                ? { ...s, done: true, items: s.items.map(i => ({ ...i, status: a.type })) }
                : s,
            ),
            progress: { ...t.progress, done: Math.min(t.progress.total, t.progress.done + 1) },
          }
        : t,
    );
    // try an immediate flush
    const { remaining, flushed } = await flushQueue();
    setPending(remaining);
    if (flushed > 0) void load();
  }

  async function onDelivered(stop: Stop, file: File) {
    setBusy(stop.stopKey);
    try {
      const [blob, gps] = await Promise.all([compressImage(file).catch(() => null), getPosition()]);
      for (const item of stop.items) {
        if (item.status === 'delivered') continue;
        await queueOutcome({
          actionId: newActionId(),
          deliveryId: item.deliveryId,
          type: 'delivered',
          ...(blob ? { photoBlob: blob, photoContentType: 'image/jpeg' } : { note: 'Delivered (no photo captured)' }),
          ...(gps ? { proof: { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracyM, capturedAt: new Date().toISOString() } } : {}),
          attempts: 0,
          nextAttemptAt: Date.now(),
          createdAt: Date.now(),
        });
      }
    } finally {
      setBusy(null);
    }
  }

  async function onMissed(stop: Stop, reason: string) {
    setBusy(stop.stopKey);
    try {
      for (const item of stop.items) {
        if (item.status !== 'locked' && item.status !== 'out_for_delivery') continue;
        await queueOutcome({
          actionId: newActionId(),
          deliveryId: item.deliveryId,
          type: 'not_delivered',
          reason,
          attempts: 0,
          nextAttemptAt: Date.now(),
          createdAt: Date.now(),
        });
      }
      setSheet(null);
    } finally {
      setBusy(null);
    }
  }

  async function onClose() {
    setBusy('close');
    try {
      await apiCloseRun({});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not close the run.');
    } finally {
      setBusy(null);
    }
  }

  /* ------------------------------------------------------------------ render */

  return (
    <main className="rider-main">
      <header className="rider-head">
        <h1>Today’s round</h1>
        <p className="sub">
          {riderName ? `${riderName} · ` : ''}
          {today ? `${today.date} · window ${today.window.start}–${today.window.end}` : '—'}
        </p>
      </header>

      {error ? <div className="rerror">{error}</div> : null}

      {loading ? (
        <>
          <div className="rskeleton" />
          <div className="rskeleton" />
          <div className="rskeleton" />
        </>
      ) : !today || !today.hasRun ? (
        <p className="rnote">
          No round assigned to you today.
          <span className="te">ఈరోజు మీకు రౌండ్ కేటాయించలేదు.</span>
        </p>
      ) : (
        <>
          <div className="rbar">
            <span className="prog">
              {today.progress.done}/{today.progress.total} stops · {today.load.cowLitres + today.load.buffaloLitres} L loaded
            </span>
            <span>{statusLabel(today.status)}</span>
          </div>

          {today.status === 'planned' ? (
            <button className="rbtn primary" onClick={onStart} disabled={busy === 'start'}>
              {busy === 'start' ? <span className="spin" /> : 'Start run'}
              <span className="te">రన్ ప్రారంభించండి</span>
            </button>
          ) : null}

          {today.status === 'in_progress' && today.navigationBatches.length > 0 ? (
            <a className="rbtn" href={today.navigationBatches[0]} target="_blank" rel="noopener noreferrer">
              Open next {Math.min(10, today.progress.total - today.progress.done)} stops in Google Maps
              <span className="te">తర్వాతి స్టాప్‌లను మ్యాప్స్‌లో తెరవండి</span>
            </a>
          ) : null}

          {today.stops.length === 0 ? (
            <p className="rnote">No stops on this run.</p>
          ) : (
            today.stops.map(stop => (
              <StopCard
                key={stop.stopKey}
                stop={stop}
                running={today.status === 'in_progress'}
                busy={busy === stop.stopKey}
                onDelivered={onDelivered}
                onOpenMissed={() => setSheet(stop)}
              />
            ))
          )}

          {today.status === 'in_progress' && today.progress.done === today.progress.total ? (
            <button className="rbtn ok" onClick={onClose} disabled={busy === 'close'}>
              {busy === 'close' ? <span className="spin" /> : 'End run (record returns)'}
              <span className="te">రన్ ముగించండి</span>
            </button>
          ) : null}

          {today.status === 'closed' ? (
            <p className="rnote">
              Run closed. Thank you.
              <span className="te">రన్ ముగిసింది. ధన్యవాదాలు.</span>
            </p>
          ) : null}
        </>
      )}

      {sheet ? (
        <MissedSheet stop={sheet} busy={busy === sheet.stopKey} onPick={onMissed} onCancel={() => setSheet(null)} />
      ) : null}

      {offline ? (
        <div className="syncbar offline">Offline — {pending} waiting to sync</div>
      ) : pending > 0 ? (
        <div className="syncbar">{pending} waiting to sync…</div>
      ) : null}
    </main>
  );
}

/* ------------------------------------------------------------- subcomponents */

function StopCard({
  stop,
  running,
  busy,
  onDelivered,
  onOpenMissed,
}: {
  stop: Stop;
  running: boolean;
  busy: boolean;
  onDelivered: (s: Stop, f: File) => void;
  onOpenMissed: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const missed = stop.items.some(i => i.status === 'not_delivered');
  return (
    <article className={`rcard${stop.done ? ' done' : ''}`}>
      <h3>
        <span className="seq">{stop.seq}</span>
        {stop.name}
        {stop.done ? (
          <span className={`pill ${missed ? 'missed' : 'delivered'}`}>{missed ? 'Missed' : 'Delivered'}</span>
        ) : null}
      </h3>
      <p className="addr">{stop.address}</p>
      {stop.landmark ? <p className="land">📍 {stop.landmark}</p> : null}
      {stop.instructions ? <p className="instr">⚠ {stop.instructions}</p> : null}
      <ul className="items">
        {stop.items.map(i => (
          <li key={i.deliveryId}>
            {i.litres} L {i.kind}
            {i.source !== 'plan' ? <span className="src">({i.source})</span> : null}
          </li>
        ))}
      </ul>

      <div className="rbtn-row" style={{ marginBottom: 8 }}>
        <a className="rbtn ghost small" href={`tel:${stop.mobile}`}>
          Call
        </a>
        {stop.navUrl ? (
          <a className="rbtn ghost small" href={stop.navUrl} target="_blank" rel="noopener noreferrer">
            Navigate
          </a>
        ) : null}
      </div>

      {running && !stop.done ? (
        <div className="actions">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) onDelivered(stop, f);
              e.currentTarget.value = '';
            }}
          />
          <button className="rbtn ok" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? <span className="spin" /> : 'Delivered'}
          </button>
          <button className="rbtn" disabled={busy} onClick={onOpenMissed}>
            Couldn’t deliver
          </button>
        </div>
      ) : null}
    </article>
  );
}

function MissedSheet({
  stop,
  busy,
  onPick,
  onCancel,
}: {
  stop: Stop;
  busy: boolean;
  onPick: (s: Stop, reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  return (
    <div className="rmodal-backdrop" onClick={onCancel}>
      <div className="rmodal" onClick={e => e.stopPropagation()}>
        <h3>
          Why couldn’t you deliver to {stop.name}?<span className="te">ఎందుకు డెలివరీ కాలేదు?</span>
        </h3>
        <div className="chips">
          {REASONS.map(r => (
            <button
              key={r.code}
              className="chip"
              aria-pressed={reason === r.code}
              onClick={() => setReason(r.code)}
            >
              {r.en}
              <span className="te">{r.te}</span>
            </button>
          ))}
        </div>
        <div className="rbtn-row">
          <button className="rbtn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="rbtn primary" disabled={!reason || busy} onClick={() => reason && onPick(stop, reason)}>
            {busy ? <span className="spin" /> : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

function statusLabel(s: Today['status']): string {
  switch (s) {
    case 'planned':
      return 'Not started';
    case 'in_progress':
      return 'In progress';
    case 'completed':
      return 'All stops done';
    case 'closed':
      return 'Closed';
    default:
      return '—';
  }
}
