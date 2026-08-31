import { Footer } from '@/components/Sections';
import { CONTACT } from '@/lib/content';

export const metadata = { title: 'Contact' };

/**
 * The form posts via mailto, not to an API route.
 *
 * That is deliberate: there is no backend for submissions yet, and a form that
 * appears to send while silently discarding the message is the worst option on a
 * page whose whole job is "we will get back to you". mailto actually delivers.
 * Swap to a route handler once Mongo and a mail provider are wired.
 */
export default function ContactPage() {
  return (
    <>
      <main className="page invert">
        <header className="page-head">
          <p className="eyebrow">Contact</p>
          <h1>{CONTACT.inviteCta}</h1>
          <p>{CONTACT.invite} Reach out and let&apos;s connect.</p>
        </header>

        <section className="contact-grid">
          <div>
            <h2>Our location</h2>
            <p>{CONTACT.address}</p>
            <p>
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(CONTACT.address)}`}
                target="_blank"
                rel="noreferrer"
              >
                Open in Maps →
              </a>
            </p>
          </div>
          <div>
            <h2>Email support</h2>
            <p><a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a></p>
          </div>
          <div>
            <h2>Phone</h2>
            {CONTACT.phones.map(t => (
              <p key={t}><a href={`tel:${t.replace(/\s/g, '')}`}>{t}</a></p>
            ))}
          </div>
          <div>
            <h2>Licence</h2>
            {CONTACT.fssaiLicence
              ? <p>FSSAI {CONTACT.fssaiLicence}</p>
              : <p><span className="pending">FSSAI licence number pending</span></p>}
          </div>
        </section>

        <section className="contact-form">
          <h2>Send a message</h2>
          <form action={`mailto:${CONTACT.email}`} method="post" encType="text/plain">
            <label>
              Your name
              <input name="name" autoComplete="name" required />
            </label>
            <label>
              Phone or email
              <input name="reply" autoComplete="tel" required />
            </label>
            <label>
              Your message
              <textarea name="message" rows={5} required />
            </label>
            <button className="cta" type="submit">Send your message</button>
          </form>
          <p className="sub-help">
            This opens your mail app — there is no server storing messages yet, and a form
            that pretended to send would be worse than one that is honest about it.
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
