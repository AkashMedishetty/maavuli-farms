import type { DayLockState, SystemStatus } from '@/lib/admin';
import { agoLabel, dateTimeLabel, timeLabel, ymdLabel } from './format';

/** A tick runs every 5 minutes; no step recorded for longer than this = the cron is not running. */
const TICK_STALE_MS = 20 * 60_000;

function LockLine({ s }: { s: DayLockState }) {
  let text: string;
  if (s.closedAt) text = `closed ${timeLabel(s.closedAt)}`;
  else if (s.locked && s.lockedAt) text = `locked ${dateTimeLabel(s.lockedAt)}${s.stops !== null ? ` · ${s.stops} stops` : ''}`;
  else if (s.pastCutoff) text = 'past the cutoff but NOT locked yet';
  else text = `open — locks ${dateTimeLabel(s.lockAt)}`;
  const bad = s.pastCutoff && !s.locked;
  return (
    <>
      <dt>{ymdLabel(s.date)}</dt>
      <dd>{bad ? <span className="ops-badge is-warn">{text}</span> : text}</dd>
    </>
  );
}

export default function SystemHealth({ s }: { s: SystemStatus }) {
  const now = new Date(s.now);
  const stale = !s.lastTickAt || now.getTime() - new Date(s.lastTickAt).getTime() > TICK_STALE_MS;
  const bad = stale || s.failing.length > 0;
  return (
    <section className={`ops-card${bad ? ' ops-card-danger' : ''}`} aria-labelledby="health-h">
      <div className="ops-card-head">
        <h2 id="health-h">System health</h2>
        <span className={`ops-badge ${bad ? 'is-bad' : 'is-ok'}`}>{bad ? 'Needs attention' : 'OK'}</span>
      </div>
      <dl className="ops-kv" style={{ marginTop: '0.5rem' }}>
        <dt>Last tick</dt>
        <dd>
          {s.lastTickAt ? `${agoLabel(s.lastTickAt, now)} (${timeLabel(s.lastTickAt)})` : 'never recorded'}
          {stale && <span className="ops-badge is-bad"> scheduler not running?</span>}
        </dd>
        <LockLine s={s.today} />
        <LockLine s={s.tomorrow} />
      </dl>
      {s.failing.length > 0 && (
        <>
          <h3 style={{ marginTop: '0.75rem' }}>Failing steps</h3>
          <ul className="ops-list">
            {s.failing.map(j => (
              <li key={j.step}>
                <strong>{j.step}</strong>
                {j.lastRunAt && <span className="ops-muted"> · {agoLabel(j.lastRunAt, now)}</span>}
                {j.lastError && <p className="ops-muted" style={{ margin: '0.2rem 0 0', overflowWrap: 'anywhere' }}>{j.lastError}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
