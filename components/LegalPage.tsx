import Link from 'next/link';
import { Footer } from './Sections';
import { CONTACT, BRAND } from '@/lib/content';
import NavPanel from './NavPanel';

export interface LegalBlock {
  heading: string;
  /** Statements that are verifiably true of the current build. */
  facts?: string[];
  /** Clauses that require the client's decision or a lawyer. Never invented. */
  pending?: string[];
}

/**
 * Legal pages are drafted, not generated.
 *
 * A privacy policy or refund policy is a binding document. Writing plausible
 * clauses would produce a page that reads like a policy and commits the client to
 * terms nobody chose — worse than an obviously incomplete page, because it looks
 * finished. So this separates two things strictly:
 *
 *   facts   — verifiably true of the code as it stands today
 *   pending — needs the client or counsel, shown as an explicit gap
 */
export default function LegalPage({
  title,
  intro,
  blocks,
  note,
}: {
  title: string;
  intro: string;
  blocks: LegalBlock[];
  note?: string;
}) {
  return (
    <>
      <NavPanel />
      <main className="page legal invert">
        <header className="page-head">
          <p className="eyebrow">{BRAND.fullName}</p>
          <h1>{title}</h1>
          <p>{intro}</p>
        </header>

        {blocks.map(b => (
          <section key={b.heading} className="legal-block">
            <h2>{b.heading}</h2>
            {b.facts?.length ? (
              <ul className="legal-facts">
                {b.facts.map(f => <li key={f}>{f}</li>)}
              </ul>
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
          <Link href="/legal/refunds">Refunds &amp; Cancellation</Link>
        </p>
      </main>
      <Footer />
    </>
  );
}
