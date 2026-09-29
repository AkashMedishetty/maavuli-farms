'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi, dayLabel, ErrorNote, useAction, type ApiFailure } from './account/api';

/**
 * Pause individual delivery dates for one plan.
 *
 * Reads GET /api/subscriptions/[id]/calendar; toggles with POST .../pause or
 * .../unpause { dates: [date] }. A date is tappable when it is on or after the first
 * open date (the server's `earliestPausableDate`) and either has a planned plan
 * delivery (pause) or is already paused (unpause). A `date_locked` answer moves the
 * first open date forward to the server's `firstOpen`, so the grid never offers a
 * closed day twice.
 */

interface CalendarData {
  subscriptionId: string;
  status: string;
  startDate: string;
  endDate: string;
  pauseAllowanceDays: number;
  pauseUsedDays: number;
  pauseRemainingDays: number;
  earliestPausableDate: string;
  pausedDates: string[];
  deliveries: { date: string; status: string; source: string }[];
}

type Load = { kind: 'loading' } | { kind: 'error'; fail: ApiFailure } | { kind: 'ready'; data: CalendarData };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function monthOf(date: string): { y: number; m: number } {
  return { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)) };
}

const monthFmt = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function PauseCalendar({ subscriptionId, cutoffLabel }: { subscriptionId: string; cutoffLabel: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [month, setMonth] = useState<{ y: number; m: number } | null>(null);
  const [busyDate, setBusyDate] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [floor, setFloor] = useState<string | null>(null);
  const action = useAction();

  const refresh = useCallback(async () => {
    const r = await callApi<CalendarData>(`/api/subscriptions/${subscriptionId}/calendar`);
    if (r.ok) {
      setLoad({ kind: 'ready', data: r.data });
      setMonth((cur) => cur ?? monthOf(r.data.earliestPausableDate > r.data.startDate ? r.data.earliestPausableDate : r.data.startDate));
    } else {
      setLoad({ kind: 'error', fail: r.fail });
    }
  }, [subscriptionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const data = load.kind === 'ready' ? load.data : null;
  const earliest = data ? (floor && floor > data.earliestPausableDate ? floor : data.earliestPausableDate) : '';
  const paused = useMemo(() => new Set(data?.pausedDates ?? []), [data]);
  const planned = useMemo(
    () => new Set((data?.deliveries ?? []).filter((d) => d.source === 'plan' && d.status === 'planned').map((d) => d.date)),
    [data],
  );

  if (load.kind === 'loading') return <p className="acct-muted" aria-live="polite">Loading your calendar…</p>;
  if (load.kind === 'error') {
    return (
      <div>
        <ErrorNote fail={load.fail} />
        <button type="button" className="acct-btn acct-btn-ghost" onClick={() => { setLoad({ kind: 'loading' }); void refresh(); }}>
          Try again
        </button>
      </div>
    );
  }
  if (!data || !month) return null;

  const toggle = async (date: string) => {
    const unpause = paused.has(date);
    setBusyDate(date);
    setNotice(null);
    let lockedFrom: string | undefined;
    const res = await action.run(async () => {
      const r = await callApi<{ message?: string }>(`/api/subscriptions/${subscriptionId}/${unpause ? 'unpause' : 'pause'}`, {
        body: { dates: [date] },
      });
      // a date_locked answer tells us where "open" really starts now
      if (!r.ok && r.fail.code === 'date_locked' && r.fail.firstOpen) lockedFrom = r.fail.firstOpen;
      return r;
    });
    setBusyDate(null);
    if (lockedFrom) setFloor(lockedFrom);
    if (res) {
      setNotice(res.message ?? (unpause ? `${dayLabel(date)} restored.` : `${dayLabel(date)} paused.`));
      router.refresh();
    }
    await refresh();
  };

  const { y, m } = month;
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < lead; i++) cells.push(<span key={`e${i}`} className="pc-day pc-empty" aria-hidden="true" />);
  for (let d = 1; d <= daysIn; d++) {
    const date = ymd(y, m, d);
    const inTerm = date >= data.startDate && date <= data.endDate;
    const isPaused = paused.has(date);
    const open = date >= earliest;
    const canPause = open && inTerm && planned.has(date) && data.pauseRemainingDays > 0;
    const canUnpause = open && isPaused;
    const tappable = (canPause || canUnpause) && !action.pending;
    const cls = ['pc-day', isPaused && 'pc-paused', inTerm && !open && 'pc-closed', !inTerm && 'pc-out', tappable && 'pc-open']
      .filter(Boolean)
      .join(' ');
    const what = isPaused
      ? open
        ? 'paused — tap to restore'
        : 'paused — closed for changes'
      : !inTerm
        ? 'not in this plan'
        : !open
          ? 'closed for changes'
          : !planned.has(date)
            ? 'no delivery to pause'
            : data.pauseRemainingDays <= 0
              ? 'no pause days left'
              : 'tap to pause';
    cells.push(
      <button
        key={date}
        type="button"
        className={cls}
        disabled={!tappable}
        onClick={() => void toggle(date)}
        aria-label={`${dayLabel(date)}: ${what}`}
        aria-pressed={isPaused}
      >
        <span>{busyDate === date ? '…' : d}</span>
      </button>,
    );
  }

  const first = monthOf(data.startDate < earliest ? earliest : data.startDate);
  const last = monthOf(data.endDate);
  const atFirst = y < first.y || (y === first.y && m <= first.m);
  const atLast = y > last.y || (y === last.y && m >= last.m);
  const step = (n: number) => {
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1 });
  };

  return (
    <div className="pc">
      <p className="pc-balance">
        <strong>{data.pauseRemainingDays}</strong> of {data.pauseAllowanceDays} pause days left
        {data.pauseRemainingDays === 0 ? ' — you can still restore a paused day.' : '.'}
      </p>
      <div className="pc-head">
        <button type="button" className="acct-btn acct-btn-ghost pc-nav" onClick={() => step(-1)} disabled={atFirst} aria-label="Previous month">
          ‹
        </button>
        <h4>{monthFmt.format(new Date(Date.UTC(y, m - 1, 1)))}</h4>
        <button type="button" className="acct-btn acct-btn-ghost pc-nav" onClick={() => step(1)} disabled={atLast} aria-label="Next month">
          ›
        </button>
      </div>
      <div className="pc-grid" role="group" aria-label="Delivery dates">
        {WEEKDAYS.map((w) => (
          <span key={w} className="pc-wd" aria-hidden="true">
            {w}
          </span>
        ))}
        {cells}
      </div>
      <p className="pc-legend">
        <span className="pc-key pc-key-paused" /> paused <span className="pc-key pc-key-closed" /> closed for changes
      </p>
      {action.pending && <p className="acct-muted" aria-live="polite">Saving…</p>}
      {notice && !action.fail && <p className="acct-ok" role="status">{notice}</p>}
      <ErrorNote fail={action.fail} />
      <p className="acct-muted">
        Changes for a day close at {cutoffLabel} the day before. The first day you can change now is{' '}
        <strong>{dayLabel(earliest)}</strong>. Each paused day adds one day at the end of your plan.
      </p>
    </div>
  );
}
