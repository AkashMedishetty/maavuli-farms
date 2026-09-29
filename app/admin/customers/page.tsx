import Link from 'next/link';
import '../crm.css';
import { loadErrorMessage, pageStaff } from '@/lib/admin';
import { searchCustomers, SEARCH_LIMIT, type CustomerRow } from '@/lib/admin-customers';
import { formatINR } from '@/lib/pricing';
import { LoadError } from '@/components/admin/ops/server';
import { PLAN_STATUS, badge } from '@/components/admin/crm/labels';

export const dynamic = 'force-dynamic';

export default async function AdminCustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const p = await pageStaff();
  if (!p) return null;
  const sp = await searchParams;
  const q = (sp.q ?? '').trim().slice(0, 100);

  let rows: CustomerRow[] | null = null;
  let error: string | null = null;
  try {
    rows = await searchCustomers(q);
  } catch (err) {
    error = loadErrorMessage(err);
  }

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Customers</p>
        <h1>{q ? `Results for “${q}”` : 'Recent customers'}</h1>
        <form className="crm-search" method="get" role="search">
          <label htmlFor="crm-q" className="crm-sr">
            Search customers
          </label>
          <input id="crm-q" type="search" name="q" defaultValue={q} placeholder="Mobile, name or address" autoComplete="off" />
          <button className="ops-btn ops-btn-primary" type="submit">
            Search
          </button>
        </form>
      </header>

      {error || !rows ? (
        <LoadError what="customers" message={error ?? 'Unknown error.'} />
      ) : rows.length === 0 ? (
        <p className="ops-empty">{q ? 'No customer matches that mobile, name or address.' : 'No customers yet.'}</p>
      ) : (
        <section className="ops-card" aria-label="Customers">
          {rows.length >= SEARCH_LIMIT && <p className="ops-muted">Showing the first {SEARCH_LIMIT}. Narrow the search to see others.</p>}
          <ul className="ops-list">
            {rows.map(c => {
              const b = badge(PLAN_STATUS, c.planStatus);
              return (
                <li key={c.mobile}>
                  <Link className="crm-row" href={`/admin/customers/${c.mobile}`}>
                    <span className="crm-row-title">
                      {c.name ?? 'No name'} <span className={`ops-badge ${b.tone}`}>{b.label}</span>
                      {c.livePlans > 1 && <span className="ops-badge">{c.livePlans} plans</span>}
                    </span>
                    <span className="crm-row-meta">
                      {c.mobile}
                      {c.address ? ` · ${c.address}` : ''}
                    </span>
                    {c.creditPaise !== 0 && <span className="crm-row-meta">Credit {formatINR(c.creditPaise)}</span>}
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
