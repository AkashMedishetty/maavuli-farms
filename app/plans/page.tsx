import Link from 'next/link';
import { Footer } from '@/components/Sections';
import { PRODUCTS, QUANTITIES, TENURES, quote, formatINR } from '@/lib/pricing';
import { SERVICEABLE_PINCODES } from '@/lib/content';

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
export default function PlansPage() {
  return (
    <>
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
          <h2>What is not settled yet</h2>
          <ul>
            <li>
              Delivery area —{' '}
              {SERVICEABLE_PINCODES.length > 0
                ? `${SERVICEABLE_PINCODES.length} pincodes`
                : <span className="pending">pincode list not published</span>}
            </li>
            <li>Delivery window and daily order cutoff — <span className="pending">to be confirmed</span></li>
            <li>Pausing while you travel — <span className="pending">policy to be confirmed</span></li>
            <li>Refunds and cancellation — <span className="pending">policy to be published</span></li>
          </ul>
          <p>
            These are blank because they are not decided, not because they are hidden. A
            plausible-looking guess on a delivery promise is worse than an empty line.
          </p>
          <Link className="cta" href="/subscribe">Build your subscription</Link>
        </section>
      </main>
      <Footer />
    </>
  );
}
