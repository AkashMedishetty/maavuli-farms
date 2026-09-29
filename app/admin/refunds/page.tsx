import Link from 'next/link';
import '../crm.css';
import { canOperate, loadErrorMessage, pageStaff } from '@/lib/admin';
import { listRefunds, REFUND_STATUSES, type RefundListRow } from '@/lib/admin-customers';
import type { RefundStatus } from '@/lib/models';
import { formatINR } from '@/lib/pricing';
import { LoadError } from '@/components/admin/ops/server';
import { dateTimeLabel } from '@/components/admin/ops/format';
import { REFUND_STATUS, badge, telHref } from '@/components/admin/crm/labels';
import Breakdown from '@/components/admin/crm/Breakdown';
import RefundActions from '@/components/admin/crm/RefundActions';

export const dynamic = 'force-dynamic';

/** Queue order: what needs a human first. */
const TABS: { id: RefundStatus | 'all'; label: string }[] = [
  { id: 'awaiting_upi', label: 'Needs UPI payout' },
  { id: 'failed', label: 'Failed' },
  { id: 'pending', label: 'Pending' },
  { id: 'processing', label: 'At Razorpay' },
  { id: 'processed', label: 'Refunded' },
  { id: 'paid_manually', label: 'Paid by UPI' },
  { id: 'all', label: 'All' },
];

export default async function AdminRefundsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const p = await pageStaff();
  if (!p) return null;
  const sp = await searchParams;
  const tab = TABS.find(t => t.id === sp.status)?.id ?? 'awaiting_upi';
  const operate = canOperate(p.staffRole);

  let rows: RefundListRow[] | null = null;
  let error: string | null = null;
  try {
    rows = await listRefunds(tab === 'all' ? undefined : REFUND_STATUSES.find(s => s === tab));
  } catch (err) {
    error = loadErrorMessage(err);
  }

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Refunds</p>
        <h1>{TABS.find(t => t.id === tab)?.label}</h1>
        <nav aria-label="Refund status">
          <ul className="crm-tabs">
            {TABS.map(t => (
              <li key={t.id}>
                <Link href={`/admin/refunds?status=${t.id}`} aria-current={t.id === tab ? 'page' : undefined}>
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {!operate && <p className="ops-sub">Read-only: an owner or ops lead processes refunds.</p>}
      </header>
      {error || !rows ? (
        <LoadError what="refunds" message={error ?? 'Unknown error.'} />
      ) : rows.length === 0 ? (
        <p className="ops-empty">No refunds with this status.</p>
      ) : (
        <section className="ops-card" aria-label="Refunds">
          {rows.length >= 200 && <p className="ops-muted">Showing the newest 200.</p>}
          <ul className="ops-list">
            {rows.map(r => {
              const b = badge(REFUND_STATUS, r.status);
              return (
                <li key={r.id}>
                  <div className="ops-card-head">
                    <h3>
                      {formatINR(r.amountPaise)} · {r.name ?? r.mobile}
                    </h3>
                    <span className={`ops-badge ${b.tone}`}>{b.label}</span>
                  </div>
                  <p className="crm-row-meta" style={{ margin: '0.2rem 0' }}>
                    <a href={telHref(r.mobile)}>{r.mobile}</a> · <Link href={`/admin/customers/${r.mobile}`}>Customer</Link> · created{' '}
                    {dateTimeLabel(r.createdAt)} · updated {dateTimeLabel(r.updatedAt)}
                  </p>
                  {r.failureReason && <p className="ops-warn">{r.failureReason}</p>}
                  {(r.upiId || r.utr || r.razorpayRefundId) && (
                    <p className="crm-row-meta">
                      {r.upiId ? `UPI ${r.upiId}` : ''}
                      {r.utr ? ` · UTR ${r.utr}` : ''}
                      {r.razorpayRefundId ? ` · Razorpay ${r.razorpayRefundId}` : ''}
                    </p>
                  )}
                  <Breakdown b={r.breakdown} />
                  {operate && <RefundActions refundId={r.id} status={r.status} upiId={r.upiId} />}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
