/**
 * Presentational pieces shared by Today and Tomorrow. Server components (no hooks);
 * the interactive AssignRider is a client island passed plain props.
 */

import type { Manifest, ManifestRun } from '@/lib/manifest';
import AssignRider, { type RiderOption } from './AssignRider';
import { DONE_ITEM_STATUSES, litres, statusLabel } from './format';
import { BalanceNote } from './BalanceNote';

export interface ItemCounts {
  total: number;
  delivered: number;
  notDelivered: number;
  unconfirmed: number;
  pending: number;
}

export function countItems(runs: readonly ManifestRun[]): ItemCounts {
  const c: ItemCounts = { total: 0, delivered: 0, notDelivered: 0, unconfirmed: 0, pending: 0 };
  for (const run of runs)
    for (const stop of run.stops)
      for (const it of stop.items) {
        if (it.status === 'cancelled') continue;
        c.total++;
        if (it.status === 'delivered') c.delivered++;
        else if (it.status === 'not_delivered') c.notDelivered++;
        else if (it.status === 'unconfirmed') c.unconfirmed++;
        else c.pending++;
      }
  return c;
}

export function runProgress(run: ManifestRun): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const s of run.stops)
    for (const it of s.items) {
      if (it.status === 'cancelled') continue;
      total++;
      if (DONE_ITEM_STATUSES.includes(it.status)) done++;
    }
  return { done, total };
}

export function LoadStats({ m }: { m: Manifest }) {
  return (
    <div className="ops-stats">
      <div className="ops-stat">
        <strong>{litres(m.totals.cowLitres)}</strong>
        <span>Cow milk</span>
      </div>
      <div className="ops-stat">
        <strong>{litres(m.totals.buffaloLitres)}</strong>
        <span>Buffalo milk</span>
      </div>
      <div className="ops-stat">
        <strong>{m.totals.stops}</strong>
        <span>Stops</span>
      </div>
      <div className="ops-stat">
        <strong>{m.totals.deliveries}</strong>
        <span>Deliveries</span>
      </div>
    </div>
  );
}

/** The unassigned bucket as a warning with the assign control (owner/ops, locked runs only). */
export function UnassignedWarning({
  m,
  riders,
  canOperate,
}: {
  m: Manifest;
  /** null = the rider list failed to load. */
  riders: RiderOption[] | null;
  canOperate: boolean;
}) {
  const run = m.runs.find(r => r.riderId === null && r.stops.length > 0);
  if (!run) return null;
  return (
    <section className="ops-card ops-card-warn" aria-labelledby="unassigned-h">
      <h2 id="unassigned-h">
        Unassigned: {run.stops.length} stop{run.stops.length === 1 ? ' has' : 's have'} no rider
      </h2>
      <p>
        {litres(run.load.cowLitres)} cow · {litres(run.load.buffaloLitres)} buffalo. These doorsteps are in a zone with
        no rider (or in no zone). Nobody will deliver them unless you assign a rider.
      </p>
      {run.runId === null ? (
        <p className="ops-muted">
          The day is not locked yet, so there is no run to hand over. Give the zone a rider under Riders &amp; zones, or
          lock the day and assign the run.
        </p>
      ) : canOperate ? (
        <AssignRider runId={run.runId} riders={riders} currentRiderId={null} />
      ) : (
        <p className="ops-muted">Ask an owner or ops lead to assign a rider.</p>
      )}
    </section>
  );
}

export function RunCards({
  m,
  riders,
  canOperate,
  showProgress,
}: {
  m: Manifest;
  /** null = the rider list failed to load. */
  riders: RiderOption[] | null;
  canOperate: boolean;
  showProgress: boolean;
}) {
  const runs = m.runs.filter(r => r.riderId !== null || r.stops.length === 0);
  if (runs.length === 0) return <p className="ops-empty">No rider runs for this date.</p>;
  return (
    <ul className="ops-list">
      {runs.map(run => {
        const p = runProgress(run);
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        return (
          <li key={run.runId ?? `preview-${run.riderId ?? 'none'}`}>
            <div className="ops-card-head">
              <h3>{run.riderName}</h3>
              <span className={`ops-badge is-${run.status}`}>{statusLabel(run.status)}</span>
            </div>
            <p className="ops-muted" style={{ margin: '0.2rem 0' }}>
              {run.load.stops} stops · {litres(run.load.cowLitres)} cow · {litres(run.load.buffaloLitres)} buffalo
            </p>
            <BalanceNote run={run} />
            {showProgress && (
              <>
                <div
                  className="ops-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={p.total}
                  aria-valuenow={p.done}
                  aria-label={`${run.riderName}: ${p.done} of ${p.total} done`}
                >
                  <span style={{ width: `${pct}%` }} />
                </div>
                <p style={{ margin: 0 }}>
                  <strong>
                    {p.done} / {p.total}
                  </strong>{' '}
                  deliveries actioned
                </p>
              </>
            )}
            {canOperate && run.runId && run.status !== 'closed' && riders === null && (
              <p className="ops-muted ops-noprint">Rider list failed to load — reload to hand this run to a cover rider.</p>
            )}
            {canOperate && run.runId && run.status !== 'closed' && riders !== null && riders.length > 1 && (
              <details className="ops-noprint">
                <summary className="ops-btn ops-btn-small" style={{ marginTop: '0.5rem' }}>
                  Hand to a cover rider
                </summary>
                <AssignRider runId={run.runId} riders={riders} currentRiderId={run.riderId} label="Cover rider" />
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}
