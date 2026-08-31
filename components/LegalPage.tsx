import Link from 'next/link';
import { Footer } from './Sections';
import { CONTACT, BRAND } from '@/lib/content';
import { type DraftAssumption, LEGAL_DRAFT_DATE } from '@/lib/legal';
import NavPanel from './NavPanel';
import '@/app/legal/legal.css';

export interface LegalBlock {
  heading: string;
  /** Plain paragraphs of policy text. Rendered before facts/terms. */
  body?: string[];
  /** Statements that are verifiably true of the current build. */
  facts?: string[];
  /** Labelled draft term/value pairs — the sensible defaults we chose. */
  terms?: { term: string; value: string }[];
  /** Clauses that require the client's decision or a lawyer. Never invented. */
  pending?: string[];
}

/**
 * Legal pages, resolved for Razorpay activation.
 *
 * A privacy or refund policy is a binding document, so this build never presents
 * an unconfirmed business fact AS a fact. But Razorpay's review needs policies
 * that actually function — real timeframes, a real refund path — so the pages are
 * written complete with sensible commercial DEFAULTS, and every value we CHOSE
 * (rather than were told) is marked as a visible draft and collected in one
 * "To confirm before we go live" block. A banner on every page states these are
 * drafts pending client confirmation and legal review, not executed terms.
 *
 *   body     — readable policy prose
 *   facts    — verifiably true of the code as it stands today
 *   terms    — the draft defaults we chose, each shown with a draft chip
 *   pending  — needs the client or counsel, shown as an explicit gap
 *   toConfirm— the page's draft assumptions, gathered into one prominent block
 */
export default function LegalPage({
  title,
  intro,
  blocks,
  toConfirm,
  note,
  showDraftBanner = true,
}: {
  title: string;
  intro: string;
  blocks: LegalBlock[];
  toConfirm?: DraftAssumption[];
  note?: string;
  showDraftBanner?: boolean;
}) {
  return (
    <>
      <NavPanel />
      <main className="page legal invert">
        {showDraftBanner ? (
          <div className="legal-banner" role="note">
            <p className="eyebrow">Draft — pending confirmation</p>
            <p>
              This is a working draft prepared for payment-gateway activation in test
              mode. Its terms have not been confirmed by {BRAND.fullName} and have not
              been reviewed by a lawyer. It is <strong>not an executed agreement</strong>.
              Values marked <span className="draft-chip">draft</span> are sensible
              defaults we proposed, not decisions the business has made — all of them are
              listed under “To confirm before we go live”.
            </p>
          </div>
        ) : null}

        <header className="page-head">
          <p className="eyebrow">{BRAND.fullName}</p>
          <h1>{title}</h1>
          <p>{intro}</p>
          <p className="legal-updated">{LEGAL_DRAFT_DATE}</p>
        </header>

        {blocks.map(b => (
          <section key={b.heading} className="legal-block">
            <h2>{b.heading}</h2>
            {b.body?.map((p, i) => <p key={i} className="legal-body">{p}</p>)}
            {b.facts?.length ? (
              <ul className="legal-facts">
                {b.facts.map(f => <li key={f}>{f}</li>)}
              </ul>
            ) : null}
            {b.terms?.length ? (
              <dl className="legal-terms">
                {b.terms.map(t => (
                  <div key={t.term} className="legal-term">
                    <dt>
                      {t.term} <span className="draft-chip">draft</span>
                    </dt>
                    <dd>{t.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {b.pending?.length ? (
              <div className="legal-pending">
                <p className="eyebrow">Awaiting the client / counsel</p>
                <ul>
                  {b.pending.map(x => <li key={x}>{x}</li>)}
                </ul>
              </div>
            ) : null}
          </section>
        ))}

        {toConfirm?.length ? (
          <section className="legal-confirm" aria-label="To confirm before we go live">
            <h2>To confirm before we go live</h2>
            <p className="legal-body">
              Every item below is a draft default we chose so this policy reads
              completely. Each needs {BRAND.fullName}’s confirmation, and the set needs a
              lawyer’s review, before these become live terms.
            </p>
            <dl className="legal-terms">
              {toConfirm.map(a => (
                <div key={a.id} className="legal-term">
                  <dt>
                    {a.label} <span className="draft-chip">draft</span>
                  </dt>
                  <dd>{a.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        <section className="legal-block">
          <h2>Contact</h2>
          <p>
            {CONTACT.address}<br />
            <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a><br />
            {CONTACT.phones.map(t => (
              <a key={t} href={`tel:${t.replace(/\s/g, '')}`}>{t}</a>
            ))}
          </p>
          {CONTACT.fssaiLicence
            ? <p>FSSAI Licence {CONTACT.fssaiLicence}</p>
            : <p><span className="pending">FSSAI licence number pending</span></p>}
        </section>

        {note ? <p className="legal-note">{note}</p> : null}

        <p className="sub-foot">
          <Link href="/legal/privacy">Privacy</Link> · <Link href="/legal/terms">Terms</Link> ·{' '}
          <Link href="/legal/refunds">Refunds &amp; Cancellation</Link> ·{' '}
          <Link href="/legal/shipping">Shipping &amp; Delivery</Link>
        </p>
      </main>
      <Footer />
    </>
  );
}
