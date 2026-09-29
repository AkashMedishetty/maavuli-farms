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
import {
  apiCloseRun,
  apiStartRun,
  compressImage,
  flushQueue,
  getPosition,
  postActionDirect,
} from './sync';
import {
  applyOptimisticOutcome,
  formatLitres,
  formatRoundDate,
  rejectionMessage,
  usableCachedRound,
} from './logic';

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
  // No navigator read during render: server and first client render agree (hydration).
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Stop | null>(null);
  /** permanently rejected actions — survives the reload that load() triggers */
  const [notice, setNotice] = useState<string | null>(null);
  const todayRef = useRef<Today | null>(null);
  todayRef.current = today;

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
      await cacheToday(data).catch(() => {
        /* IndexedDB unavailable — the round just won't be there offline */
      });
    } catch (e) {
      // Offline / server down: fall back to the cached round, but only if it is TODAY's.
      const cached = usableCachedRound((await readCachedToday()) as Today | null, new Date());
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

  const runFlush = useCallback(async () => {
    try {
      const { flushed, remaining, rejected } = await flushQueue();
      setPending(remaining);
      if (rejected.length > 0) setNotice(rejectionMessage(rejected, todayRef.current?.stops ?? []));
      // A rejection means our optimistic "done" is wrong: reload the true state.
      if (flushed > 0 || rejected.length > 0) void load();
    } catch {
      /* IndexedDB unavailable — outcomes are posted directly instead (recordOutcome) */
    }
  }, [load]);

  async function retryLoad() {
    setBusy('load');
    try {
      await load();
    } finally {
      setBusy(null);
    }
  }

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
    setOffline(!navigator.onLine);
    const online = () => {
      setOffline(false);
      void runFlush();
    };
    const off = () => setOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', off);
    const timer = setInterval(() => void runFlush(), 15_000);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', off);
      clearInterval(timer);
    };
  }, [load, refreshPending, runFlush]);

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

  /** optimistic: mark the stop done locally; progress is recounted per stop */
  function markLocal(a: QueuedAction) {
    setToday(t => (t ? applyOptimisticOutcome(t, a.deliveryId, a.type) : t));
  }

  /**
   * Save the outcome to the phone's queue first. If the phone cannot store it
   * (IndexedDB unavailable / full), post it directly when online. Returns false
   * (with an error shown) when the outcome was NOT recorded anywhere.
   */
  async function recordOutcome(a: QueuedAction): Promise<boolean> {
    let stored = true;
    try {
      await enqueueAction(a);
    } catch {
      stored = false;
    }

    if (stored) {
      markLocal(a);
      await refreshPending();
      await runFlush(); // try an immediate flush
      return true;
    }

    if (!navigator.onLine) {
      setError(
        'Could not save this on the phone and you are offline — nothing was recorded. Keep the app open and try again when you have signal.',
      );
      return false;
    }
    try {
      const out = await postActionDirect(a);
      if (out.kind === 'ok') {
        markLocal(a);
        return true;
      }
      if (out.kind === 'rejected') {
        setNotice(rejectionMessage([{ actionId: a.actionId, deliveryId: a.deliveryId, error: out.error }], today?.stops ?? []));
        void load();
        return false;
      }
      setError(`Could not save this on the phone and the server said: ${out.error}. Try again in a moment.`);
      return false;
    } catch {
      setError('Could not save this on the phone or send it — nothing was recorded. Try again and keep the app open.');
      return false;
    }
  }

  async function onDelivered(stop: Stop, file: File) {
    setBusy(stop.stopKey);
    try {
      const [blob, gps] = await Promise.all([compressImage(file).catch(() => null), getPosition()]);
      for (const item of stop.items) {
        if (item.status === 'delivered') continue;
        const saved = await recordOutcome({
          actionId: newActionId(),
          deliveryId: item.deliveryId,
          type: 'delivered',
          ...(blob ? { photoBlob: blob, photoContentType: 'image/jpeg' } : { note: 'Delivered (no photo captured)' }),
          ...(gps ? { proof: { lat: gps.lat, lng: gps.lng, accuracyM: gps.accuracyM, capturedAt: new Date().toISOString() } } : {}),
          attempts: 0,
          nextAttemptAt: Date.now(),
          createdAt: Date.now(),
        });
        if (!saved) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record this delivery. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function onMissed(stop: Stop, reason: string) {
    setBusy(stop.stopKey);
    let ok = true;
    try {
      for (const item of stop.items) {
        if (item.status !== 'locked' && item.status !== 'out_for_delivery') continue;
        const saved = await recordOutcome({
          actionId: newActionId(),
          deliveryId: item.deliveryId,
          type: 'not_delivered',
          reason,
          attempts: 0,
          nextAttemptAt: Date.now(),
          createdAt: Date.now(),
        });
        if (!saved) {
          ok = false; // keep the sheet open so the rider can retry
          break;
        }
      }
      if (ok) setSheet(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record this. Try again.');
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

  const failedRead = !loading && !today && !!error;

  return (
    <main className="rider-main">
      <header className="rider-head">
        <h1>Today’s round</h1>
        <p className="sub">
          {riderName ? `${riderName} · ` : ''}
          {today ? `${formatRoundDate(today.date)} · window ${today.window.start}–${today.window.end}` : '—'}
        </p>
      </header>

      {error && !failedRead ? (
        <div className="rerror" role="alert">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="rerror" role="alert">
          {notice}
          <button className="rbtn ghost small" style={{ marginTop: 10 }} onClick={() => setNotice(null)}>
            OK
          </button>
        </div>
      ) : null}

      {loading ? (
        <>
          <div className="rskeleton" />
          <div className="rskeleton" />
          <div className="rskeleton" />
        </>
      ) : failedRead ? (
        <div className="rerror" role="alert">
          <p style={{ margin: '0 0 12px' }}>
            {error}
            <span className="te">మీ రౌండ్ లోడ్ కాలేదు.</span>
          </p>
          <button className="rbtn" onClick={retryLoad} disabled={busy === 'load'}>
            {busy === 'load' ? <span className="spin" /> : 'Try again'}
          </button>
        </div>
      ) : !today || !today.hasRun ? (
        <p className="rnote">
          No round assigned to you today.
          <span className="te">ఈరోజు మీకు రౌండ్ కేటాయించలేదు.</span>
        </p>
      ) : (
        <>
          <div className="rbar">
            <span className="prog">
              {today.progress.done}/{today.progress.total} stops · {formatLitres(today.load.cowLitres + today.load.buffaloLitres)} L loaded
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
        <div className="syncbar offline" role="status">
          Offline — {pending} waiting to sync
        </div>
      ) : pending > 0 ? (
        <div className="syncbar" role="status">
          {pending} waiting to sync…
        </div>
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
            {formatLitres(i.litres)} L {i.kind}
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
  const boxRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  // Focus into the sheet, Escape closes, Tab stays inside, focus returns to the trigger.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    boxRef.current?.querySelector<HTMLElement>('.chip')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRef.current();
        return;
      }
      if (e.key !== 'Tab' || !boxRef.current) return;
      const f = Array.from(boxRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'));
      const first = f[0];
      const last = f[f.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !boxRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !boxRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (trigger && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <div className="rmodal-backdrop" onClick={onCancel}>
      <div
        ref={boxRef}
        className="rmodal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="missed-sheet-title"
        onClick={e => e.stopPropagation()}
      >
        <h3 id="missed-sheet-title">
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
