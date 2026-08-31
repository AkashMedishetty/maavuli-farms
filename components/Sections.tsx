import Link from 'next/link';
import Kolam from './Kolam';
import { BRAND, CONTACT, SERVICEABLE_PINCODES } from '@/lib/content';
import { PRODUCTS, TENURES, quote, formatINR } from '@/lib/pricing';
import { cow, tree, ground, figure, render } from '@/lib/warli';

/* ------------------------------------------------------------------ farm ---- */

/**
 * No photography anywhere on this site, by decision. So the farm section carries
 * itself on type and on parametric Warli — which also keeps it a few KB instead
 * of a few hundred.
 */
const FARM_SCENE = [
  `<g transform="translate(60,150) scale(1.05)">${render(tree(), 3.2)}</g>`,
  `<g transform="translate(250,214)">${render(cow(), 3.2)}</g>`,
  `<g transform="translate(470,232) scale(.84)">${render(cow(), 3.8)}</g>`,
  `<g transform="translate(196,196) scale(.9)">${render(figure({ armL: 96, bendL: 52, armR: 88, bendR: 58, legL: 30, legR: 4 }), 3.6)}</g>`,
  `<g transform="translate(0,300)">${render(ground(660, 2, 30), 3)}</g>`,
].join('');

export function Farm() {
  return (
    <section className="section farm panel" id="our-farm">
      <div className="farm-copy">
        <p className="eyebrow">Our farm</p>
        <h2>Milk that has not been anywhere else first.</h2>
        <p>
          Collected, bottled and delivered within hours — no processing plant, no
          middleman, no tanker in between. What leaves the farm in the morning is what
          arrives at your door.
        </p>
        <Link className="cta" href="/our-farm">
          Read the whole story
        </Link>
      </div>
      <svg className="farm-art" viewBox="0 0 660 340" aria-hidden="true">
        <g dangerouslySetInnerHTML={{ __html: FARM_SCENE }} />
      </svg>
    </section>
  );
}

/* --------------------------------------------------------------- pricing ---- */

/**
 * An overview, not a spreadsheet. The client was explicit that a full matrix
 * "feels like providing them an excel", so this shows the shape of the offer —
 * per-litre rate falling as the term lengthens — and sends people into the
 * builder for the actual decision.
 *
 * Every number is derived by lib/pricing.ts. Nothing here is typed by hand, which
 * is why the seven arithmetic errors in the client's own matrix cannot reappear.
 */
export function PricingOverview() {
  return (
    <section className="section pricing" id="plans">
      <p className="eyebrow">Plans</p>
      <h2>The longer you stay, the less each litre costs.</h2>

      <div className="price-grid">
        {PRODUCTS.map(p => (
          <div key={p.kind} className="price-card">
            <h3>{p.label}</h3>
            {p.breedClaim ? <p className="eyebrow">{p.breedClaim}</p> : null}
            <ul>
              {TENURES.map(t => {
                const q = quote(p.kind, 'one', t.id);
                return (
                  <li key={t.id}>
                    <span className="price-term">{t.label}</span>
                    <span className="price-rate">{formatINR(q.perLitrePaise)}<i>/L</i></span>
                    <span className="price-off">
                      {t.discountPct > 0 ? `−${t.discountPct}%` : '—'}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="price-foot">
              1 litre a day · {formatINR(quote(p.kind, 'one', '1y').finalPaise)} for a year
            </p>
          </div>
        ))}
      </div>

      <p className="price-note">
        Half-litre plans available at the same per-litre rates.{' '}
        {SERVICEABLE_PINCODES.length > 0 ? (
          <>We deliver to {SERVICEABLE_PINCODES.length} pincodes.</>
        ) : (
          <>
            Delivery area <span className="pending">to be confirmed</span> — we check your
            pincode before you pay, never after.
          </>
        )}
      </p>

      <Link className="cta" href="/subscribe">
        Build your subscription
      </Link>
    </section>
  );
}

/* ------------------------------------------------------------------- cta ---- */

export function CallToAction() {
  return (
    <section className="section cta-band panel">
      <Kolam size={128} strokeWidth={2.4} className="cta-mark" />
      <h2>{BRAND.tagline}</h2>
      <p>{BRAND.premise}</p>
      <Link className="cta" href="/subscribe">
        Start a subscription
      </Link>
    </section>
  );
}

/* ---------------------------------------------------------------- footer ---- */

export function Footer() {
  return (
    <footer className="foot panel">
      <div>
        <Kolam size={54} strokeWidth={5} dots={false} />
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
        <h3>More</h3>
        <ul>
          <li><Link href="/our-farm">Our Farm</Link></li>
          <li><Link href="/plans">Plans &amp; Pricing</Link></li>
          <li><Link href="/contact">Contact</Link></li>
          <li><Link href="/legal/privacy">Privacy</Link></li>
          <li><Link href="/legal/terms">Terms</Link></li>
          <li><Link href="/legal/refunds">Refunds &amp; Cancellation</Link></li>
        </ul>
      </div>
      <div className="foot-legal">
        {/* Legally required on a dairy site. Shown as pending, never invented. */}
        {CONTACT.fssaiLicence
          ? <p>FSSAI Licence {CONTACT.fssaiLicence}</p>
          : <p><span className="pending">FSSAI licence number pending</span></p>}
        <p>© {new Date().getFullYear()} {BRAND.fullName}</p>
      </div>
    </footer>
  );
}
