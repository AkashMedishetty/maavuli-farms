import Link from 'next/link';
import { Footer } from '@/components/Sections';
import { PRODUCTS, QUANTITIES, TENURES, quote, formatINR } from '@/lib/pricing';
import { SERVICEABLE_PINCODES } from '@/lib/content';
import NavPanel from '@/components/NavPanel';
import { dayRulesForDisplay } from '@/lib/settings';
import { hmLabel } from '@/lib/cutoff';

// The window and cut-off are live ops settings (admin can move them), so this page
// reads them per request, as the /legal pages do — never a hardcoded time.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Plans & Pricing' };

/**
 * The full matrix lives HERE and nowhere else. The client's exact objection to it
 * on the homepage was "it feels more like just providing them an excel — they don't
 * want to know all the prices if they're not interested", but she also said a table
 * on a separate page was fine. This is that page.
 *
 * Every cell is derived. Her hand-typed matrix had seven arithmetic errors, all in
 * the cow tables; none of them can appear here because none of them are stored.
 */
export default async function PlansPage() {
  const rules = await dayRulesForDisplay();
  return (
    <>
      <NavPanel />
      <main className="page invert">
        <header className="page-head">
          <p className="eyebrow">Plans &amp; pricing</p>
          <h1>Every plan, in full.</h1>
          <p>
            One rate per litre per milk, then a discount that grows with the term. That is
            the whole pricing model — there is nothing else in it.
          </p>
        </header>

        {PRODUCTS.map(p => (
          <section key={p.kind} className="plan-table-wrap">
            <h2>{p.label}</h2>
            {p.breedClaim && <p className="eyebrow">{p.breedClaim}</p>}
            {QUANTITIES.map(qy => (
              <div key={qy.id} className="plan-table">
                <h3>{qy.label}</h3>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Term</th>
                      <th scope="col">Full price</th>
                      <th scope="col">You pay</th>
                      <th scope="col">You save</th>
                      <th scope="col">Per litre</th>
                    </tr>
                  </thead>
                  <tbody>
                    {TENURES.map(t => {
                      const q = quote(p.kind, qy.id, t.id);
                      return (
                        <tr key={t.id}>
                          <th scope="row">{t.label} <i>{q.days} days</i></th>
                          <td>{q.discountPct > 0 ? <s>{formatINR(q.originalPaise)}</s> : formatINR(q.originalPaise)}</td>
                          <td><b>{formatINR(q.finalPaise)}</b></td>
                          <td>{q.savingPaise > 0 ? `${formatINR(q.savingPaise)} (${q.discountPct}%)` : '—'}</td>
                          <td>{formatINR(q.perLitrePaise)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        ))}

        <section className="plan-fine">
          <h2>How delivery works</h2>
          <ul>
            <li>
              Delivery window — every morning between {hmLabel(rules.windowStart)} and {hmLabel(rules.windowEnd)}.
            </li>
            <li>
              Daily cut-off — changes for a morning (a pause, extra milk, a cancellation, an address change) close at{' '}
              {hmLabel(rules.cutoffTime)} the day before.
            </li>
            <li>
              Pausing while you travel — every plan includes pause days; pick them on the calendar in your account
              before the {hmLabel(rules.cutoffTime)} cut-off. Your account shows how many your plan has left.
            </li>
            <li>
              Refunds and cancellation — you can cancel any time; see the{' '}
              <Link href="/legal/refunds">refund &amp; cancellation policy</Link> for how the refund is worked out.
            </li>
          </ul>
          <h2>What is not settled yet</h2>
          <ul>
            <li>
              Delivery area —{' '}
              {SERVICEABLE_PINCODES.length > 0
                ? `${SERVICEABLE_PINCODES.length} pincodes`
                : <span className="pending">pincode list not published</span>}
            </li>
          </ul>
          <p>
            This is blank because it is not decided, not because it is hidden. Your door’s map pin is checked
            against the areas we serve before you pay, never after.
          </p>
          <Link className="cta" href="/subscribe">Build your subscription</Link>
        </section>
      </main>
      <Footer />
    </>
  );
}
