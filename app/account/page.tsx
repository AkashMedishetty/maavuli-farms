import Link from 'next/link';
import { Footer } from '@/components/Sections';
import { CONTACT } from '@/lib/content';

export const metadata = { title: 'My Deliveries' };

/**
 * Deliberately NOT a working login.
 *
 * There is no auth, no session, no Mongo collection and no OTP provider yet. A
 * login box that accepts a number and does nothing is the single most damaging
 * thing to put on a page called "My Deliveries" — it teaches people the site is
 * broken. So this states the position and gives the two things that do work today.
 *
 * When it is built, the shape is settled: OTP on the mobile number, no password.
 * Accounts get auto-provisioned from the Razorpay webhook payload, which means
 * nobody ever CHOOSES a password — so owning a password reset flow for credentials
 * the user never set is pure liability.
 */
export default function AccountPage() {
  return (
    <>
      <main className="page">
        <header className="page-head">
          <p className="eyebrow">My deliveries</p>
          <h1>Not switched on yet.</h1>
          <p>
            Accounts, pausing and delivery history are <span className="pending">in
            build</span>. Until they are live, your subscription is managed by us directly —
            and we would rather say that than show you a login that does nothing.
          </p>
        </header>

        <section className="acct-grid">
          <div>
            <h2>To change or pause a delivery</h2>
            <p>
              Call <a href={`tel:${CONTACT.phones[0]?.replace(/\s/g, '')}`}>{CONTACT.phones[0]}</a>{' '}
              or email <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>. Same day, if
              you reach us before the morning round.
            </p>
          </div>
          <div>
            <h2>When it does arrive</h2>
            <p>
              Sign-in will be a one-time code on your mobile number — no password to
              choose, forget, or have leaked.
            </p>
          </div>
        </section>

        <p className="sub-foot">
          <Link href="/subscribe">Start a subscription</Link>
        </p>
      </main>
      <Footer />
    </>
  );
}
