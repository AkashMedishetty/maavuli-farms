import { canOperate, loadErrorMessage, pageStaff, zoneOptions } from '@/lib/admin';
import { listDisruptions } from '@/lib/disruptions';
import { addDaysYMD, istYMD } from '@/lib/cutoff';
import { LoadError, pageCtx } from '@/components/admin/ops/server';
import DisruptionForm from '@/components/admin/ops/DisruptionForm';
import { dateTimeLabel, ymdLabel } from '@/components/admin/ops/format';

export const dynamic = 'force-dynamic';

/** Mirrors lib/disruptions MAX_DAYS_AHEAD (the API enforces it). */
const MAX_DAYS_AHEAD = 7;

export default async function AdminDisruptionsPage() {
  const p = await pageStaff();
  if (!p) return null;
  const ctx = await pageCtx(p);
  const today = istYMD(ctx.now);
  const operate = canOperate(p.staffRole);

  const [dRes, zRes] = await Promise.allSettled([listDisruptions(addDaysYMD(today, -30), addDaysYMD(today, MAX_DAYS_AHEAD)), zoneOptions()]);
  const zoneName = new Map(zRes.status === 'fulfilled' ? zRes.value.map(z => [z.id, z.name]) : []);

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Disruptions</p>
        <h1>Rain, strikes, breakdowns</h1>
        <p className="ops-sub">When a whole area cannot be served, declare it once instead of marking each stop.</p>
      </header>

      {operate &&
        (zRes.status === 'fulfilled' ? (
          <DisruptionForm zones={zRes.value} minDate={today} maxDate={addDaysYMD(today, MAX_DAYS_AHEAD)} />
        ) : (
          <LoadError what="zones (needed to declare a disruption)" message={loadErrorMessage(zRes.reason)} />
        ))}

      <section className="ops-card" aria-labelledby="past-h">
        <h2 id="past-h">Last 30 days and upcoming</h2>
        {dRes.status === 'rejected' ? (
          <LoadError what="disruptions" message={loadErrorMessage(dRes.reason)} />
        ) : dRes.value.length === 0 ? (
          <p className="ops-empty">No disruptions declared.</p>
        ) : (
          <ul className="ops-list">
            {dRes.value.map(d => (
              <li key={d._id!.toHexString()}>
                <div className="ops-card-head">
                  <h3>{ymdLabel(d.date)}</h3>
                  <span className="ops-badge is-bad">{d.affected} affected</span>
                </div>
                <p style={{ margin: '0.2rem 0' }}>{d.reason}</p>
                <p className="ops-muted" style={{ margin: 0 }}>
                  {d.zoneIds.length === 0 ? 'All zones' : d.zoneIds.map(z => zoneName.get(z.toHexString()) ?? 'deleted zone').join(', ')} ·
                  declared {dateTimeLabel(d.createdAt.toISOString())} by {d.createdBy.id}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
