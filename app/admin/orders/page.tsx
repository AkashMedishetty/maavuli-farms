import Link from 'next/link';
import '../crm.css';
import { loadErrorMessage, pageStaff } from '@/lib/admin';
import {
  abandonedCheckouts,
  ABANDONED_LOOKBACK_DAYS,
  listOrders,
  ORDER_STATUSES,
  type AbandonedRow,
  type OrderListRow,
} from '@/lib/admin-customers';
import type { OrderStatus } from '@/lib/models';
import { formatINR } from '@/lib/pricing';
import { LoadError, pageCtx } from '@/components/admin/ops/server';
import { agoLabel, dateTimeLabel } from '@/components/admin/ops/format';
import { ORDER_STATUS, badge, telHref } from '@/components/admin/crm/labels';

export const dynamic = 'force-dynamic';

const TABS: { id: string; label: string }[] = [
  { id: 'paid', label: 'Paid' },
  { id: 'abandoned', label: 'Abandoned checkouts' },
  { id: 'created', label: 'Unpaid' },
  { id: 'failed', label: 'Failed' },
  { id: 'expired', label: 'Expired' },
  { id: 'partially_refunded', label: 'Partly refunded' },
  { id: 'refunded', label: 'Refunded' },
  { id: 'all', label: 'All' },
];

function Abandoned({ rows, now }: { rows: AbandonedRow[]; now: Date }) {
  if (!rows.length) return <p className="ops-empty">No abandoned checkouts in the last {ABANDONED_LOOKBACK_DAYS} days.</p>;
  return (
    <section className="ops-card" aria-label="Abandoned checkouts">
      <p className="ops-muted">
        Started a checkout in the last {ABANDONED_LOOKBACK_DAYS} days and have not paid since. One row per customer, newest first — call
        and help them finish.
      </p>
      <ul className="ops-list">
        {rows.map(r => (
          <li key={r.orderId}>
            <div className="ops-card-head">
              <strong>{r.name ?? r.mobile}</strong>
              <span className="ops-badge">{agoLabel(r.createdAt, now)}</span>
            </div>
            <p style={{ margin: '0.2rem 0' }}>
              {r.plan} · {formatINR(r.amountPaise)} · {r.status === 'created' ? 'still open' : 'expired'}
              {r.attempts > 1 ? ` · ${r.attempts} attempts` : ''}
            </p>
            <div className="ops-actions">
              <a className="ops-btn ops-btn-primary" href={telHref(r.mobile)}>
                Call {r.mobile}
              </a>
              <Link className="ops-btn" href={`/admin/customers/${r.mobile}`}>
                Customer
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Orders({ rows, nextHref }: { rows: OrderListRow[]; nextHref: string | null }) {
  if (!rows.length) return <p className="ops-empty">No orders with this status.</p>;
  return (
    <section className="ops-card" aria-label="Orders">
      <ul className="ops-list">
        {rows.map(o => {
          const b = badge(ORDER_STATUS, o.status);
          return (
            <li key={o.id}>
              <Link className="crm-row" href={`/admin/customers/${o.mobile}`}>
                <span className="crm-row-title">
                  {o.name ?? o.mobile} <span className={`ops-badge ${b.tone}`}>{b.label}</span>
                </span>
                <span className="crm-row-meta">
                  {o.plan} · {formatINR(o.amountPaise)}
                  {o.creditAppliedPaise ? ` (${formatINR(o.creditAppliedPaise)} credit)` : ''}
                  {o.refundedPaise ? ` · ${formatINR(o.refundedPaise)} refunded` : ''}
                </span>
                <span className="crm-row-meta">
                  {o.mobile} · {dateTimeLabel(o.paidAt ?? o.createdAt)}
                  {o.purpose !== 'new' ? ` · ${o.purpose}` : ''}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {nextHref && (
        <div className="ops-actions">
          <Link className="ops-btn" href={nextHref}>
            Older orders
          </Link>
        </div>
      )}
    </section>
  );
}

export default async function AdminOrdersPage({ searchParams }: { searchParams: Promise<{ status?: string; cursor?: string }> }) {
  const p = await pageStaff();
  if (!p) return null;
  const sp = await searchParams;
  const tab = TABS.some(t => t.id === sp.status) ? (sp.status as string) : 'paid';
  const ctx = await pageCtx(p);

  let abandoned: AbandonedRow[] | null = null;
  let orders: { orders: OrderListRow[]; nextCursor: string | null } | null = null;
  let error: string | null = null;
  try {
    if (tab === 'abandoned') abandoned = await abandonedCheckouts(ctx);
    else {
      const status = ORDER_STATUSES.includes(tab as OrderStatus) ? (tab as OrderStatus) : undefined;
      const cursor = sp.cursor && /^[a-f0-9]{24}$/i.test(sp.cursor) ? sp.cursor : undefined;
      orders = await listOrders({ ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) });
    }
  } catch (err) {
    error = loadErrorMessage(err);
  }

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Orders</p>
        <h1>{TABS.find(t => t.id === tab)?.label}</h1>
        <nav aria-label="Order status">
          <ul className="crm-tabs">
            {TABS.map(t => (
              <li key={t.id}>
                <Link href={`/admin/orders?status=${t.id}`} aria-current={t.id === tab ? 'page' : undefined}>
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {sp.cursor && <p className="ops-muted">Showing older orders. <Link href={`/admin/orders?status=${tab}`}>Back to newest</Link></p>}
      </header>
      {error ? (
        <LoadError what="orders" message={error} />
      ) : abandoned ? (
        <Abandoned rows={abandoned} now={ctx.now} />
      ) : orders ? (
        <Orders rows={orders.orders} nextHref={orders.nextCursor ? `/admin/orders?status=${tab}&cursor=${orders.nextCursor}` : null} />
      ) : (
        <LoadError what="orders" message="Unknown error." />
      )}
    </>
  );
}
