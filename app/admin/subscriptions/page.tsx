import Link from 'next/link';
import '../crm.css';
import { loadErrorMessage, pageStaff } from '@/lib/admin';
import { listSubscriptions, SUB_LIST_LIMIT, SUB_STATUSES, type SubscriptionFilters, type SubscriptionListRow } from '@/lib/admin-customers';
import type { SubStatus } from '@/lib/models';
import { LoadError, pageCtx } from '@/components/admin/ops/server';
import { ymdLabel } from '@/components/admin/ops/format';
import { PLAN_STATUS, badge } from '@/components/admin/crm/labels';

export const dynamic = 'force-dynamic';

export default async function AdminSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; ending?: string; renewal?: string }>;
}) {
  const p = await pageStaff();
  if (!p) return null;
  const sp = await searchParams;
  const status = SUB_STATUSES.find(s => s === sp.status) as SubStatus | undefined;
  const endingWithin = sp.ending === '7' ? 7 : sp.ending === '14' ? 14 : undefined;
  const renewal = sp.renewal === 'queued' || sp.renewal === 'none' ? sp.renewal : undefined;
  const filters: SubscriptionFilters = { ...(status ? { status } : {}), ...(endingWithin ? { endingWithin } : {}), ...(renewal ? { renewal } : {}) };
  const ctx = await pageCtx(p);

  let res: { rows: SubscriptionListRow[]; truncated: boolean } | null = null;
  let error: string | null = null;
  try {
    res = await listSubscriptions(filters, ctx);
  } catch (err) {
    error = loadErrorMessage(err);
  }

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Subscriptions</p>
        <h1>Plans</h1>
        <form className="crm-filters" method="get">
          <label>
            Status
            <select name="status" defaultValue={status ?? ''}>
              <option value="">Any</option>
              {SUB_STATUSES.filter(s => s !== 'paused').map(s => (
                <option key={s} value={s}>
                  {badge(PLAN_STATUS, s).label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ending
            <select name="ending" defaultValue={endingWithin ? String(endingWithin) : ''}>
              <option value="">Any time</option>
              <option value="7">Within 7 days</option>
              <option value="14">Within 14 days</option>
            </select>
          </label>
          <label>
            Renewal
            <select name="renewal" defaultValue={renewal ?? ''}>
              <option value="">Either</option>
              <option value="queued">Renewal queued</option>
              <option value="none">Not renewed</option>
            </select>
          </label>
          <button className="ops-btn ops-btn-primary" type="submit">
            Filter
          </button>
          <Link className="ops-btn" href="/admin/subscriptions?ending=7&renewal=none">
            Ending soon, not renewed
          </Link>
        </form>
      </header>
      {error || !res ? (
        <LoadError what="plans" message={error ?? 'Unknown error.'} />
      ) : res.rows.length === 0 ? (
        <p className="ops-empty">No plans match these filters.</p>
      ) : (
        <section className="ops-card" aria-label="Plans">
          <p className="ops-muted">
            {res.truncated ? `Showing the first ${SUB_LIST_LIMIT}; narrow the filters to see the rest.` : `${res.rows.length} plan${res.rows.length === 1 ? '' : 's'}.`}
          </p>
          <ul className="ops-list">
            {res.rows.map(s => {
              const b = badge(PLAN_STATUS, s.status);
              return (
                <li key={s.id}>
                  <Link className="crm-row" href={`/admin/customers/${s.mobile}#plans`}>
                    <span className="crm-row-title">
                      {s.name ?? s.mobile} <span className={`ops-badge ${b.tone}`}>{b.label}</span>
                      {s.renewedBy && <span className="ops-badge is-ok">Renewal queued</span>}
                    </span>
                    <span className="crm-row-meta">
                      {s.label} · {ymdLabel(s.startDate)} → {ymdLabel(s.endDate)} · {s.daysDelivered}/{s.daysTotal} delivered
                    </span>
                    <span className="crm-row-meta">
                      {s.mobile}
                      {s.address ? ` · ${s.address}` : ''}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
