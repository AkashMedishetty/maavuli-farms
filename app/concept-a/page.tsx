import Hero from '@/components/concept-a/Hero';
import StoryPath from '@/components/concept-a/StoryPath';
import { BRAND, CONTACT, PENDING, SERVICEABLE_PINCODES } from '@/lib/content';
import { PRODUCTS, quote, formatINR } from '@/lib/pricing';
import NavPanel from '@/components/NavPanel';

/**
 * The plan chooser deliberately does NOT open with a price table. The client was
 * explicit: "this table feels more like just providing them an excel — they don't
 * want to know all the prices if they're not interested." So step one is the only
 * decision most customers have already made: which milk.
 *
 * Each card shows a "from" rate, which is the 1-year per-litre — the honest floor,
 * derived, never typed.
 */
export default function Page() {
  return (
    <main>
      <Hero />
      <StoryPath />

      <section className="section" id="plans">
        <p className="eyebrow">Start here</p>
        <h2 style={{ fontSize: 'var(--step-2)', marginBottom: '2.5rem', maxWidth: '24ch' }}>
          Which milk do you want?
        </h2>

        <div className="plan-grid">
          {PRODUCTS.map(p => {
            const best = quote(p.kind, 'one', '1y');
            const entry = quote(p.kind, 'one', '1m');
            return (
              <a key={p.kind} className="plan-card" href={`/subscribe/${p.kind}`}>
                <h3>{p.label}</h3>
                {/* breedClaim is null until the client confirms it. A2/desi would be a
                    headline, but asserting it unconfirmed would be inventing a fact. */}
                {p.breedClaim ? <p className="eyebrow">{p.breedClaim}</p> : null}
                <p className="plan-rate">
                  from <strong>{formatINR(best.perLitrePaise)}</strong> / litre
                </p>
                <p className="plan-note">
                  {formatINR(entry.perLitrePaise)} / litre on the monthly plan · save{' '}
                  {best.discountPct}% over a year
                </p>
                <span className="plan-go">Choose a quantity →</span>
              </a>
            );
          })}
        </div>

        <p className="plan-serviceable">
          {SERVICEABLE_PINCODES.length > 0 ? (
            <>We deliver to {SERVICEABLE_PINCODES.length} pincodes across Hyderabad.</>
          ) : (
            <>
      <NavPanel />
              Delivery area:{' '}
              <span className="pending">pincode list to be confirmed</span> — we check
              serviceability before you pay, never after.
            </>
          )}
        </p>
      </section>

      <footer className="foot">
        <div>
          <h3>{BRAND.fullName}</h3>
          <p>{BRAND.premise}</p>
        </div>
        <div>
          <h3>Visit</h3>
          <p>{CONTACT.address}</p>
        </div>
        <div>
          <h3>{CONTACT.inviteCta}</h3>
          <ul>
            <li><a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a></li>
            {CONTACT.phones.map(t => (
              <li key={t}><a href={`tel:${t.replace(/\s/g, '')}`}>{t}</a></li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Licence</h3>
          {CONTACT.fssaiLicence ? (
            <p>FSSAI {CONTACT.fssaiLicence}</p>
          ) : (
            // Legally required on a dairy site. Shown as pending, never invented.
            <p><span className="pending">FSSAI licence number pending</span></p>
          )}
          <ul>
            {PENDING.map(x => <li key={x} style={{ fontSize: 'var(--step--1)' }}>{x}</li>)}
          </ul>
        </div>
      </footer>
    </main>
  );
}
