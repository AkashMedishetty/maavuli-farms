import Link from 'next/link';
import { activeRiderOptions, canOperate, loadErrorMessage, pageStaff, systemStatus, type RiderOptionRow, type SystemStatus } from '@/lib/admin';
import { getManifest, type Manifest } from '@/lib/manifest';
import { istYMD } from '@/lib/cutoff';
import { LoadError, pageCtx } from '@/components/admin/ops/server';
import { countItems, LoadStats, RunCards, UnassignedWarning } from '@/components/admin/ops/ManifestView';
import SystemHealth from '@/components/admin/ops/SystemHealth';
import { ymdLabel } from '@/components/admin/ops/format';

export const dynamic = 'force-dynamic';

/** Today: what is going out this morning, and whether it is getting there. */
export default async function AdminTodayPage() {
  const p = await pageStaff();
  if (!p) return null; // the layout shows the sign-in / not-authorised prompt
  const ctx = await pageCtx(p);
  const today = istYMD(ctx.now);
  const operate = canOperate(p.staffRole);

  // Each block loads independently so one failure never blanks the whole morning.
  const [mRes, rRes, sRes] = await Promise.allSettled([getManifest(today, ctx), activeRiderOptions(), systemStatus(ctx)]);
  const manifest: Manifest | null = mRes.status === 'fulfilled' ? mRes.value : null;
  // null (not []) on a failed read, so the assign controls say "failed to load", not "no riders".
  const riders: RiderOptionRow[] | null = rRes.status === 'fulfilled' ? rRes.value : null;
  const system: SystemStatus | null = sRes.status === 'fulfilled' ? sRes.value : null;
  const counts = manifest ? countItems(manifest.runs) : null;

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Today</p>
        <h1>{ymdLabel(today)}</h1>
        {manifest && (
          <p className="ops-sub">
            {manifest.locked ? 'Runs are frozen.' : 'Not locked — no deliveries were planned for today.'}{' '}
            <Link href="/admin/exceptions">Exceptions</Link> · <Link href="/admin/tomorrow">Tomorrow&rsquo;s plan</Link>
          </p>
        )}
      </header>

      {!manifest ? (
        <LoadError what="today's manifest" message={loadErrorMessage(mRes.status === 'rejected' ? mRes.reason : null)} />
      ) : (
        <>
          <LoadStats m={manifest} />
          {counts && (
            <div className="ops-stats" aria-label="Delivery progress">
              <div className="ops-stat">
                <strong>{counts.delivered}</strong>
                <span>Delivered</span>
              </div>
              <div className={`ops-stat${counts.notDelivered ? ' is-bad' : ''}`}>
                <strong>{counts.notDelivered}</strong>
                <span>Not delivered</span>
              </div>
              <div className="ops-stat">
                <strong>{counts.pending}</strong>
                <span>Pending</span>
              </div>
              <div className={`ops-stat${counts.unconfirmed ? ' is-warn' : ''}`}>
                <strong>{counts.unconfirmed}</strong>
                <span>
                  Unconfirmed{counts.unconfirmed > 0 && <> · <Link href={`/admin/exceptions?date=${today}`}>resolve</Link></>}
                </span>
              </div>
            </div>
          )}

          {rRes.status === 'rejected' && (
            <LoadError what="the rider list" message={loadErrorMessage(rRes.reason)} />
          )}
          <UnassignedWarning m={manifest} riders={riders} canOperate={operate} />

          <section className="ops-section ops-card" aria-labelledby="runs-h">
            <h2 id="runs-h">Runs</h2>
            {manifest.runs.length === 0 ? (
              <p className="ops-empty">No deliveries today.</p>
            ) : (
              <RunCards m={manifest} riders={riders} canOperate={operate} showProgress />
            )}
          </section>
        </>
      )}

      {system ? (
        <SystemHealth s={system} />
      ) : (
        <LoadError what="system health" message={loadErrorMessage(sRes.status === 'rejected' ? sRes.reason : null)} />
      )}
    </>
  );
}
