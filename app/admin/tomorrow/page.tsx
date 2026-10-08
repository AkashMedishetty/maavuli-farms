import Link from 'next/link';
import { activeRiderOptions, canOperate, loadErrorMessage, pageStaff } from '@/lib/admin';
import { getManifest, type Manifest, type ManifestRun } from '@/lib/manifest';
import { addDaysYMD, istYMD, isYMD } from '@/lib/cutoff';
import { LoadError, pageCtx } from '@/components/admin/ops/server';
import { LoadStats, RunCards, UnassignedWarning } from '@/components/admin/ops/ManifestView';
import { LockNowButton, PrintButton } from '@/components/admin/ops/Actions';
import { dateTimeLabel, litres, milkLabel, statusLabel, ymdLabel } from '@/components/admin/ops/format';
import { BalanceNote } from '@/components/admin/ops/BalanceNote';

export const dynamic = 'force-dynamic';

function runKey(run: ManifestRun): string {
  return run.runId ?? `rider-${run.riderId ?? 'unassigned'}`;
}

function itemsText(items: ManifestRun['stops'][number]['items']): string {
  return items
    .filter(i => i.status !== 'cancelled')
    .map(i => `${milkLabel(i.kind)} ${litres(i.litres)}${i.source === 'plan' ? '' : ` (${i.source === 'makeup' ? 'make-up' : 'extra'})`}`)
    .join(', ');
}

function LoadSheet({ m, run }: { m: Manifest; run: ManifestRun }) {
  return (
    <article className="ops-sheet" aria-label={`Load sheet for ${run.riderName}`}>
      <h2>
        {run.riderName} — {ymdLabel(m.date)}
      </h2>
      <p style={{ margin: '0 0 0.5rem' }}>
        {run.load.stops} stops · load {litres(run.load.cowLitres)} cow + {litres(run.load.buffaloLitres)} buffalo
        {!m.locked && ' · PREVIEW, order may change at lock'}
      </p>
      {run.stops.length === 0 ? (
        <p className="ops-empty">No stops.</p>
      ) : (
        <div className="ops-table">
          <table>
            <thead>
              <tr>
                <th scope="col" className="num">#</th>
                <th scope="col">Name</th>
                <th scope="col">Address</th>
                <th scope="col">Landmark</th>
                <th scope="col">Items</th>
              </tr>
            </thead>
            <tbody>
              {run.stops.map((s, i) => (
                <tr key={s.stopKey}>
                  <td className="num">{s.seq || i + 1}</td>
                  <th scope="row">{s.snapshot.name}</th>
                  <td>
                    {s.snapshot.address}
                    {s.snapshot.instructions && <div className="ops-muted">{s.snapshot.instructions}</div>}
                  </td>
                  <td>{s.snapshot.landmark ?? '—'}</td>
                  <td>{itemsText(s.items)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

/**
 * Day plan for tomorrow (or ?date=): a no-write preview before the cutoff, the
 * frozen runs after. Packing list per milk type and per rider, printable load sheets.
 */
export default async function AdminDayPlanPage({ searchParams }: { searchParams: Promise<{ date?: string; sheet?: string }> }) {
  const p = await pageStaff();
  if (!p) return null;
  const ctx = await pageCtx(p);
  const today = istYMD(ctx.now);
  const tomorrow = addDaysYMD(today, 1);
  const sp = await searchParams;
  const badDate = sp.date !== undefined && !isYMD(sp.date);
  const date = sp.date && isYMD(sp.date) ? sp.date : tomorrow;
  const operate = canOperate(p.staffRole);

  const [mRes, rRes] = await Promise.allSettled([getManifest(date, ctx), activeRiderOptions()]);
  // null (not []) on a failed read, so the assign controls say "failed to load", not "no riders".
  const riders = rRes.status === 'fulfilled' ? rRes.value : null;

  if (mRes.status === 'rejected') {
    return (
      <>
        <header className="ops-head">
          <p className="ops-eyebrow">Day plan</p>
          <h1>{ymdLabel(date)}</h1>
        </header>
        <LoadError what="the day plan" message={loadErrorMessage(mRes.reason)} />
      </>
    );
  }
  const m = mRes.value;

  // single load sheet (for printing one rider)
  if (sp.sheet) {
    const run = m.runs.find(r => runKey(r) === sp.sheet);
    return (
      <>
        <div className="ops-actions ops-noprint">
          <Link className="ops-btn" href={`/admin/tomorrow?date=${date}`}>
            ← Back to the day plan
          </Link>
          {run && <PrintButton label="Print this sheet" />}
        </div>
        {run ? (
          <div className="ops-sheets">
            <LoadSheet m={m} run={run} />
          </div>
        ) : (
          <p className="ops-error" role="alert">
            That load sheet is not in this day&rsquo;s plan any more (the day may have been re-locked). Go back and pick
            the rider again.
          </p>
        )}
      </>
    );
  }

  const canLockNow = operate && !m.locked && (date === today || date === tomorrow);
  const perRider = [...m.runs].sort((a, b) => a.riderName.localeCompare(b.riderName));

  return (
    <>
      <header className="ops-head ops-noprint">
        <p className="ops-eyebrow">{date === tomorrow ? 'Tomorrow' : date === today ? 'Today' : 'Day plan'}</p>
        <h1>{ymdLabel(date)}</h1>
        <form className="ops-datebar" method="get">
          <label>
            Date
            <input type="date" name="date" defaultValue={date} />
          </label>
          <button className="ops-btn" type="submit">
            Show
          </button>
          {date !== tomorrow && (
            <Link className="ops-btn" href="/admin/tomorrow">
              Tomorrow
            </Link>
          )}
        </form>
        {badDate && <p className="ops-error">That date was not valid (YYYY-MM-DD), so tomorrow is shown.</p>}
      </header>

      <section className={`ops-card ${m.locked ? '' : 'ops-card-warn'} ops-noprint`} aria-label="Lock state">
        {m.locked ? (
          <p style={{ margin: 0 }}>
            <span className="ops-badge is-ok">Locked</span> Runs are frozen. Changes customers make now apply from a
            later date.
          </p>
        ) : (
          <>
            <p>
              <span className="ops-badge is-preview">Preview</span> Locks at <strong>{dateTimeLabel(m.lockAt)}</strong>.
              Until then customers can still pause or add milk, so these numbers can change.
            </p>
            {canLockNow && <LockNowButton date={date} dateLabel={ymdLabel(date)} />}
          </>
        )}
      </section>

      <div className="ops-noprint">
        <h2>Packing list</h2>
        <LoadStats m={m} />

        {rRes.status === 'rejected' && <LoadError what="the rider list" message={loadErrorMessage(rRes.reason)} />}
        <UnassignedWarning m={m} riders={riders} canOperate={operate} />

        {m.runs.length === 0 ? (
          <p className="ops-empty">No deliveries planned for {ymdLabel(date)}.</p>
        ) : (
          <>
            <section className="ops-card" aria-labelledby="per-rider-h">
              <h2 id="per-rider-h">Per rider</h2>
              <div className="ops-table">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Rider</th>
                      <th scope="col" className="num">Cow</th>
                      <th scope="col" className="num">Buffalo</th>
                      <th scope="col" className="num">Stops</th>
                      <th scope="col">Status</th>
                      <th scope="col">Load sheet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perRider.map(run => (
                      <tr key={runKey(run)}>
                        <th scope="row">
                          {run.riderName}
                          <BalanceNote run={run} />
                        </th>
                        <td className="num">{litres(run.load.cowLitres)}</td>
                        <td className="num">{litres(run.load.buffaloLitres)}</td>
                        <td className="num">{run.load.stops}</td>
                        <td>
                          <span className={`ops-badge is-${run.status}`}>{statusLabel(run.status)}</span>
                        </td>
                        <td>
                          <Link className="ops-btn ops-btn-small" href={`/admin/tomorrow?date=${date}&sheet=${encodeURIComponent(runKey(run))}`}>Open</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <td className="num">{litres(m.totals.cowLitres)}</td>
                      <td className="num">{litres(m.totals.buffaloLitres)}</td>
                      <td className="num">{m.totals.stops}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {m.locked && (
              <section className="ops-card" aria-labelledby="runs-h">
                <h2 id="runs-h">Runs</h2>
                <RunCards m={m} riders={riders} canOperate={operate} showProgress={date <= today} />
              </section>
            )}

            <div className="ops-actions">
              <PrintButton label="Print all load sheets" />
            </div>
          </>
        )}
      </div>

      {m.runs.length > 0 && (
        <div className="ops-sheets">
          <h2 className="ops-noprint" style={{ marginTop: '1.25rem' }}>
            Load sheets
          </h2>
          {perRider.map(run => (
            <LoadSheet key={runKey(run)} m={m} run={run} />
          ))}
        </div>
      )}
    </>
  );
}
