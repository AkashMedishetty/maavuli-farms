import { canOperate, loadErrorMessage, pageStaff } from '@/lib/admin';
import { listRouteSummaries, STALE_DAYS, type RouteSummary } from '@/lib/route-plan';
import { googleRoutesConfigured, googleUsage } from '@/lib/google-routes';
import { LoadError, pageCtx } from '@/components/admin/ops/server';
import { ReoptimiseButton } from '@/components/admin/ops/Actions';
import { agoLabel, dateTimeLabel, distance } from '@/components/admin/ops/format';

export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<RouteSummary['source'], string> = {
  google: 'Google (real roads)',
  local: 'Local solver (straight-line)',
  none: 'Never optimised',
};

function UsageBar({ used, cap, label }: { used: number; cap: number; label: string }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 100;
  return (
    <div className={`ops-stat${pct >= 90 ? ' is-bad' : pct >= 70 ? ' is-warn' : ''}`}>
      <strong>
        {used} / {cap}
      </strong>
      <span>{label}</span>
      <div className="ops-progress" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Standing routes per rider, Google usage vs caps, and manual re-optimisation. */
export default async function AdminRoutesPage() {
  const p = await pageStaff();
  if (!p) return null;
  const ctx = await pageCtx(p);
  const operate = canOperate(p.staffRole);
  const configured = googleRoutesConfigured();

  const [rRes, uRes] = await Promise.allSettled([listRouteSummaries(), googleUsage(ctx.now)]);
  const staleMs = STALE_DAYS * 86_400_000;

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Routes</p>
        <h1>Standing routes</h1>
        <p className="ops-sub">
          Each rider keeps a fixed stop order. It is re-optimised automatically when their stops change (dirty) or every{' '}
          {STALE_DAYS} days; the daily lock never calls Google.
        </p>
      </header>

      <section className="ops-card" aria-labelledby="google-h">
        <h2 id="google-h">Google Routes usage</h2>
        {!configured && (
          <p className="ops-warn">
            <code>GOOGLE_MAPS_SERVER_KEY</code> is not set, so every route uses the local straight-line solver. Stop
            order is still sensible; distances are estimates.
          </p>
        )}
        {uRes.status === 'fulfilled' ? (
          <div className="ops-stats">
            <UsageBar used={uRes.value.today} cap={uRes.value.dailyCap} label="Calls today" />
            <UsageBar used={uRes.value.month} cap={uRes.value.monthlyCap} label="Calls this month" />
          </div>
        ) : (
          <LoadError what="Google usage" message={loadErrorMessage(uRes.reason)} />
        )}
        <p className="ops-muted">At a cap, optimisation falls back to the local solver until the counter resets.</p>
      </section>

      <section className="ops-card" aria-labelledby="routes-h">
        <h2 id="routes-h">Riders</h2>
        {rRes.status === 'rejected' ? (
          <LoadError what="standing routes" message={loadErrorMessage(rRes.reason)} />
        ) : rRes.value.length === 0 ? (
          <p className="ops-empty">No active riders.</p>
        ) : (
          <ul className="ops-list">
            {rRes.value.map(r => {
              const stale = r.optimizedAt !== null && ctx.now.getTime() - new Date(r.optimizedAt).getTime() > staleMs;
              return (
                <li key={r.riderId}>
                  <div className="ops-card-head">
                    <h3>{r.name}</h3>
                    <span>
                      {r.dirty && <span className="ops-badge is-dirty">Needs re-optimising</span>}{' '}
                      {stale && <span className="ops-badge is-warn">Older than {STALE_DAYS} days</span>}
                    </span>
                  </div>
                  <dl className="ops-kv" style={{ margin: '0.4rem 0' }}>
                    <dt>Stops</dt>
                    <dd>{r.stops}</dd>
                    <dt>Source</dt>
                    <dd>{SOURCE_LABEL[r.source]}</dd>
                    <dt>Optimised</dt>
                    <dd>{r.optimizedAt ? `${dateTimeLabel(r.optimizedAt)} (${agoLabel(r.optimizedAt, ctx.now)})` : '—'}</dd>
                    <dt>Distance</dt>
                    <dd>
                      {r.totalM !== undefined ? distance(r.totalM) : '—'}
                      {r.totalS !== undefined ? ` · ~${Math.round(r.totalS / 60)} min driving` : ''}
                    </dd>
                    {r.dirty && (
                      <>
                        <dt>Why dirty</dt>
                        <dd>{r.dirtyReason ?? 'stops changed'}</dd>
                      </>
                    )}
                  </dl>
                  {operate && <ReoptimiseButton riderId={r.riderId} riderName={r.name} />}
                </li>
              );
            })}
          </ul>
        )}
        {operate && configured && (
          <p className="ops-muted">Each re-optimise with 2–26 stops uses one Google call.</p>
        )}
      </section>
    </>
  );
}
