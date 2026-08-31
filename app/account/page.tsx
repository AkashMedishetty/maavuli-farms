import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Footer } from '@/components/Sections';
import NavPanel from '@/components/NavPanel';
import { CONTACT } from '@/lib/content';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col } from '@/lib/models';
import { formatINR } from '@/lib/pricing';
import {
  getSession,
  issueOtp,
  verifyOtp,
  InvalidMobileError,
  RateLimitError,
  SmsNotConfiguredError,
  VerifyError,
} from '@/lib/auth';

export const metadata = { title: 'My Deliveries' };
// This page reads the session cookie and live data — never prerender or cache it.
export const dynamic = 'force-dynamic';

/**
 * The account page. Two states, both server-rendered:
 *
 *  · no session  -> the OTP form (enter mobile, then enter the 6-digit code)
 *  · session     -> that user's subscriptions and their next 7 scheduled deliveries
 *
 * The form is driven by Server Actions, not a client bundle: the whole page stays a
 * server component so it can read the cookie and the collections directly, and the
 * two-step form is expressed with a URL search param (?step=code&m=<mobile>) rather
 * than client state. Errors are surfaced the same way (?err=...), so nothing here
 * needs "use client".
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// --------------------------------------------------------------- server actions

async function requestCodeAction(formData: FormData): Promise<void> {
  'use server';
  const mobile = String(formData.get('mobile') ?? '');
  let target: string;
  try {
    const result = await issueOtp(mobile);
    // In dev with no SMS provider, issueOtp returns the code; pass it through the
    // URL so a developer can see it without a gateway. This branch is unreachable
    // in production (issueOtp throws SmsNotConfiguredError there instead).
    const dev = result.devCode ? `&dev=${result.devCode}` : '';
    target = `/account?step=code&m=${encodeURIComponent(mobile)}${dev}`;
  } catch (err) {
    if (err instanceof InvalidMobileError) target = '/account?err=mobile';
    else if (err instanceof RateLimitError) target = `/account?err=rate&retry=${err.retryAfterSeconds}`;
    else if (err instanceof SmsNotConfiguredError) target = '/account?err=sms';
    else if (err instanceof NotConfiguredError) target = '/account?err=db';
    else throw err;
  }
  redirect(target); // outside the try: redirect() throws NEXT_REDIRECT by design
}

async function verifyCodeAction(formData: FormData): Promise<void> {
  'use server';
  const mobile = String(formData.get('mobile') ?? '');
  const code = String(formData.get('code') ?? '');
  let target = '/account'; // success: cookie set inside verifyOtp, land on signed-in view
  try {
    await verifyOtp(mobile, code);
  } catch (err) {
    if (err instanceof VerifyError) target = `/account?step=code&m=${encodeURIComponent(mobile)}&err=code`;
    else if (err instanceof NotConfiguredError) target = '/account?err=db';
    else throw err;
  }
  redirect(target); // outside the try: redirect() throws NEXT_REDIRECT by design
}

// --------------------------------------------------------------------- helpers

const ERR_COPY: Record<string, string> = {
  mobile: 'Enter a valid 10-digit mobile number.',
  code: 'That code is not valid or has expired. Request a fresh one.',
  sms: 'Sign-in by SMS is not switched on yet. Please call or email us to manage your subscription.',
  db: 'We could not reach the account service just now. Please try again shortly.',
  rate: 'Too many code requests. Please wait a little before trying again.',
};

/** Next 7 scheduled deliveries for a mobile, sorted by date, read directly. */
async function loadSignedIn(mobile: string) {
  const db = await getDb();
  const subscriptions = await col
    .subscriptions(db)
    .find({ mobile })
    .sort({ createdAt: -1 })
    .toArray();

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
  const deliveries = await col
    .deliveries(db)
    .find({ mobile, status: 'scheduled', date: { $gte: today } })
    .sort({ date: 1 })
    .limit(7)
    .toArray();

  return { subscriptions, deliveries };
}

// ----------------------------------------------------------------------- views

export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;

  // Resolve the session up front. If the account service (DB) is down we cannot
  // know whether the user is signed in — say so honestly rather than showing a
  // fake logged-out form.
  let session: Awaited<ReturnType<typeof getSession>> | null = null;
  let sessionError = false;
  try {
    session = await getSession();
  } catch (err) {
    if (err instanceof NotConfiguredError) sessionError = true;
    else throw err;
  }

  if (session) return <SignedIn mobile={session.mobile} name={session.user?.name ?? null} />;

  const step = one(sp.step) === 'code' ? 'code' : 'mobile';
  const mobile = one(sp.m) ?? '';
  const errKey = one(sp.err);
  const err = errKey ? ERR_COPY[errKey] : undefined;
  const devCode = one(sp.dev);

  return (
    <>
      <NavPanel />
      <main className="page">
        <header className="page-head">
          <p className="eyebrow">My deliveries</p>
          <h1>Sign in.</h1>
          <p>
            A one-time code goes to your mobile number — no password to choose, forget, or
            have leaked.
          </p>
        </header>

        {sessionError ? (
          <section className="acct-grid">
            <div>
              <h2>Temporarily unavailable</h2>
              <p>
                We could not reach the account service. To change or pause a delivery in the
                meantime, call{' '}
                <a href={`tel:${CONTACT.phones[0]?.replace(/\s/g, '')}`}>{CONTACT.phones[0]}</a> or
                email <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>.
              </p>
            </div>
          </section>
        ) : (
          <section className="contact-form">
            {err ? <p className="sub-notice">{err}</p> : null}

            {step === 'mobile' ? (
              <form action={requestCodeAction}>
                <label>
                  Mobile number
                  <input
                    type="tel"
                    name="mobile"
                    inputMode="numeric"
                    autoComplete="tel"
                    placeholder="10-digit mobile"
                    defaultValue={mobile}
                    required
                  />
                </label>
                <button type="submit" className="cta">Send code</button>
              </form>
            ) : (
              <form action={verifyCodeAction}>
                <input type="hidden" name="mobile" value={mobile} />
                <label>
                  Enter the 6-digit code sent to {mobile || 'your mobile'}
                  <input
                    type="text"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{6}"
                    maxLength={6}
                    placeholder="••••••"
                    required
                    autoFocus
                  />
                </label>
                {devCode ? (
                  <p className="sub-help">
                    Development mode, no SMS provider configured — your code is{' '}
                    <strong>{devCode}</strong>.
                  </p>
                ) : null}
                <button type="submit" className="cta">Verify &amp; sign in</button>
                <p className="sub-help">
                  <Link href="/account">Use a different number</Link>
                </p>
              </form>
            )}
          </section>
        )}

        <p className="sub-foot">
          <Link href="/subscribe">Start a subscription</Link>
        </p>
      </main>
      <Footer />
    </>
  );
}

async function logoutAction(): Promise<void> {
  'use server';
  const { destroySession, SESSION_COOKIE } = await import('@/lib/auth');
  const { cookies } = await import('next/headers');
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value ?? '';
  try {
    await destroySession(raw);
  } catch (err) {
    if (!(err instanceof NotConfiguredError)) throw err;
    jar.delete(SESSION_COOKIE);
  }
  redirect('/account');
}

async function SignedIn({ mobile, name }: { mobile: string; name: string | null }) {
  let data: Awaited<ReturnType<typeof loadSignedIn>> | null = null;
  let dataError = false;
  try {
    data = await loadSignedIn(mobile);
  } catch (err) {
    if (err instanceof NotConfiguredError) dataError = true;
    else throw err;
  }

  return (
    <>
      <NavPanel />
      <main className="page">
        <header className="page-head">
          <p className="eyebrow">My deliveries</p>
          <h1>{name ? `Welcome, ${name}.` : 'Your deliveries.'}</h1>
          <p>Signed in as {mobile}.</p>
        </header>

        {dataError ? (
          <section className="acct-grid">
            <div>
              <h2>Temporarily unavailable</h2>
              <p>
                We could not load your subscriptions just now. Please refresh in a moment, or
                call <a href={`tel:${CONTACT.phones[0]?.replace(/\s/g, '')}`}>{CONTACT.phones[0]}</a>.
              </p>
            </div>
          </section>
        ) : (
          <>
            <section className="acct-grid">
              <div>
                <h2>Subscriptions</h2>
                {data && data.subscriptions.length > 0 ? (
                  <ul className="sub-summary">
                    {data.subscriptions.map((s) => (
                      <li key={String(s._id)}>
                        <span>
                          {s.kind === 'cow' ? 'Cow' : 'Buffalo'} milk · {s.qtyNum}/{s.qtyDen} L/day
                          <br />
                          {s.startDate} → {s.endDate}
                        </span>
                        <b>
                          {s.status}
                          <br />
                          {s.daysDelivered}/{s.daysTotal} days
                        </b>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    No active subscription on this number.{' '}
                    <Link href="/subscribe">Start one</Link>.
                  </p>
                )}
              </div>

              <div>
                <h2>Next 7 deliveries</h2>
                {data && data.deliveries.length > 0 ? (
                  <ul className="sub-summary">
                    {data.deliveries.map((d) => (
                      <li key={String(d._id)}>
                        <span>{d.date}</span>
                        <b>
                          {d.litres} L {d.kind === 'cow' ? 'cow' : 'buffalo'}
                        </b>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No deliveries scheduled yet.</p>
                )}
              </div>
            </section>

            <p className="sub-help">
              To change or pause a delivery, call{' '}
              <a href={`tel:${CONTACT.phones[0]?.replace(/\s/g, '')}`}>{CONTACT.phones[0]}</a> or
              email <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>.
            </p>
          </>
        )}

        <form action={logoutAction} className="sub-foot">
          <button type="submit" className="sub-back">Sign out</button>
        </form>
      </main>
      <Footer />
    </>
  );
}
