import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Footer } from '@/components/Sections';
import NavPanel from '@/components/NavPanel';
import { CONTACT } from '@/lib/content';
import { NotConfiguredError } from '@/lib/db';
import { formatINR } from '@/lib/pricing';
import { hmLabel } from '@/lib/cutoff';
import { customerActor, pageNow } from '@/lib/clock';
import {
  getSession,
  issueOtp,
  clientIpFrom,
  verifyOtp,
  InvalidMobileError,
  OtpDeliveryError,
  RateLimitError,
  SmsNotConfiguredError,
  VerifyError,
} from '@/lib/auth';
import { getAccountView, type AccountView, type DeliveryView, type PlanView, type Section } from '@/lib/account';
import { PauseCalendar } from '@/components/PauseCalendar';
import { CancelSubscription } from '@/components/CancelSubscription';
import { ExtraMilk } from '@/components/account/ExtraMilk';
import { AddressForm, PreferencesForm, RefundUpi, ReportProblem } from '@/components/account/forms';
import { safeNext } from './next';
import './account.css';

export const metadata = { title: 'My Deliveries' };
// Reads the session cookie and live data — never prerender or cache it.
export const dynamic = 'force-dynamic';

/**
 * /account — the customer dashboard.
 *
 *  · no session → OTP sign-in (Server Actions; step and errors ride in the URL, so
 *    the form needs no client bundle). `?next=/admin` or `/rider` returns staff and
 *    riders to where they came from after signing in (same-origin paths only).
 *  · session    → lib/account.getAccountView, rendered section by section. Each
 *    section has its own error state: a failed read is never shown as "nothing here".
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function withNext(path: string, next: string | null): string {
  if (!next) return path;
  return `${path}${path.includes('?') ? '&' : '?'}next=${encodeURIComponent(next)}`;
}

// --------------------------------------------------------------- server actions

async function requestCodeAction(formData: FormData): Promise<void> {
  'use server';
  const mobile = String(formData.get('mobile') ?? '');
  const next = safeNext(String(formData.get('next') ?? ''));
  let target: string;
  try {
    const { headers } = await import('next/headers');
    const result = await issueOtp(mobile, { ip: clientIpFrom(await headers()) });
    // Dev (or explicit demo mode) with no provider: issueOtp returns the code so it
    // can be shown. Unreachable in normal production (it throws instead).
    const dev = result.devCode ? `&dev=${result.devCode}${result.demo ? '&demo=1' : ''}` : '';
    target = `/account?step=code&m=${encodeURIComponent(mobile)}${dev}`;
  } catch (err) {
    if (err instanceof InvalidMobileError) target = `/account?err=mobile&m=${encodeURIComponent(mobile)}`;
    else if (err instanceof RateLimitError) target = `/account?err=rate&retry=${err.retryAfterSeconds}`;
    else if (err instanceof SmsNotConfiguredError) target = '/account?err=sms';
    else if (err instanceof OtpDeliveryError) target = `/account?err=delivery&m=${encodeURIComponent(mobile)}`;
    else if (err instanceof NotConfiguredError) target = '/account?err=db';
    else throw err;
  }
  redirect(withNext(target, next)); // outside the try: redirect() throws NEXT_REDIRECT by design
}

async function verifyCodeAction(formData: FormData): Promise<void> {
  'use server';
  const mobile = String(formData.get('mobile') ?? '');
  const code = String(formData.get('code') ?? '');
  const next = safeNext(String(formData.get('next') ?? ''));
  let target = next ?? '/account';
  try {
    await verifyOtp(mobile, code); // sets the session cookie
  } catch (err) {
    if (err instanceof VerifyError) target = withNext(`/account?step=code&m=${encodeURIComponent(mobile)}&err=code`, next);
    else if (err instanceof NotConfiguredError) target = withNext('/account?err=db', next);
    else throw err;
  }
  redirect(target);
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

// --------------------------------------------------------------------- helpers

function errCopy(key: string | undefined, retry: string | undefined): string | undefined {
  switch (key) {
    case 'mobile':
      return 'Enter a valid 10-digit mobile number.';
    case 'code':
      return 'That code is not valid or has expired. Request a fresh one.';
    case 'sms':
      return 'Sign-in codes are not switched on yet. Please call or email us to manage your subscription.';
    case 'delivery':
      return 'We could not send your code just now. Wait a minute and tap “Send code” again.';
    case 'db':
      return 'We could not reach the account service just now. Please try again shortly.';
    case 'rate': {
      const s = Number(retry);
      const mins = Number.isFinite(s) && s > 0 ? Math.ceil(s / 60) : null;
      return mins
        ? `Too many code requests. Please try again in about ${mins} minute${mins === 1 ? '' : 's'}.`
        : 'Too many code requests. Please wait a little before trying again.';
    }
    default:
      return undefined;
  }
}

const dayFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
const atFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

function dl(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  return dayFmt.format(new Date(`${ymd}T12:00:00+05:30`)).replace(',', '');
}

function at(iso: string): string {
  return atFmt.format(new Date(iso));
}

function litres(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1).replace(/\.0$/, '')} L`;
}

function kindName(k: 'cow' | 'buffalo'): string {
  return k === 'cow' ? 'Cow' : 'Buffalo';
}

function Help() {
  const phone = CONTACT.phones[0];
  return (
    <>
      call {phone ? <a href={`tel:${phone.replace(/\s/g, '')}`}>{phone}</a> : 'us'} or email{' '}
      <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
    </>
  );
}

function SectionError({ error }: { error: string }) {
  return (
    <div className="acct-err" role="alert">
      <p>{error}</p>
      <p>
        If you need something changed now, <Help />.
      </p>
    </div>
  );
}

/** Render a section's data, or its error — never an empty state for a failed read. */
function Guard<T>({ s, children }: { s: Section<T>; children: (data: T) => React.ReactNode }) {
  return s.ok ? <>{children(s.data)}</> : <SectionError error={s.error} />;
}

// ----------------------------------------------------------------------- views

export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const next = safeNext(one(sp.next));

  // If the account service (DB) is down we cannot know whether the user is signed
  // in — say so honestly rather than showing a fake logged-out form.
  let session: Awaited<ReturnType<typeof getSession>> | null = null;
  let sessionError = false;
  try {
    session = await getSession();
  } catch (err) {
    if (err instanceof NotConfiguredError) sessionError = true;
    else throw err;
  }

  if (session) {
    if (next) redirect(next);
    return <SignedIn mobile={session.mobile} />;
  }

  const step = one(sp.step) === 'code' ? 'code' : 'mobile';
  const mobile = one(sp.m) ?? '';
  const err = errCopy(one(sp.err), one(sp.retry));
  const devCode = one(sp.dev);
  const demo = one(sp.demo) === '1';

  return (
    <>
      <NavPanel />
      <main className="page">
        <header className="page-head">
          <p className="eyebrow">My deliveries</p>
          <h1>Sign in.</h1>
          <p>
            {next?.startsWith('/admin')
              ? 'Sign in with your staff mobile number to open the admin console.'
              : next?.startsWith('/rider')
                ? 'Sign in with your registered delivery-partner mobile number.'
                : 'A one-time code goes to your mobile number — no password to choose, forget, or have leaked.'}
          </p>
        </header>

        {sessionError ? (
          <section className="acct-grid">
            <div>
              <h2>Temporarily unavailable</h2>
              <p>
                We could not reach the account service. To change or pause a delivery in the meantime, <Help />.
              </p>
            </div>
          </section>
        ) : (
          <section className="contact-form">
            {err ? (
              <p className="sub-notice" role="alert">
                {err}
              </p>
            ) : null}

            {step === 'mobile' ? (
              <form action={requestCodeAction}>
                {next ? <input type="hidden" name="next" value={next} /> : null}
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
                <button type="submit" className="cta">
                  Send code
                </button>
              </form>
            ) : (
              <form action={verifyCodeAction}>
                <input type="hidden" name="mobile" value={mobile} />
                {next ? <input type="hidden" name="next" value={next} /> : null}
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
                    {demo ? 'Demo mode' : 'Development mode, no message provider configured'} — your code is{' '}
                    <strong>{devCode}</strong>.
                  </p>
                ) : null}
                <button type="submit" className="cta">
                  Verify &amp; sign in
                </button>
                <p className="sub-help">
                  <Link href={withNext('/account', next)}>Use a different number or resend the code</Link>
                </p>
              </form>
            )}
          </section>
        )}

        {!next ? (
          <p className="sub-foot">
            <Link href="/subscribe">Start a subscription</Link>
          </p>
        ) : null}
      </main>
      <Footer />
    </>
  );
}

async function SignedIn({ mobile }: { mobile: string }) {
  let view: AccountView | null = null;
  let loadError = false;
  try {
    view = await getAccountView(mobile, { now: await pageNow(), actor: customerActor(mobile) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[account] view failed', err instanceof Error ? err.message : err);
    loadError = true;
  }

  const name = view?.profile.ok ? view.profile.data.name : null;

  return (
    <>
      <NavPanel />
      <main className="acct">
        <header className="acct-head">
          <p className="acct-eyebrow">My deliveries</p>
          <h1>{name ? `Welcome, ${name}.` : 'Your deliveries.'}</h1>
          <p className="acct-muted">Signed in as {mobile}.</p>
        </header>

        {loadError || !view ? (
          <section className="acct-card">
            <h2>Temporarily unavailable</h2>
            <p>
              We could not load your account just now. Please refresh in a moment, or <Help />.
            </p>
          </section>
        ) : (
          <Dashboard view={view} mobile={mobile} />
        )}

        <form action={logoutAction} className="acct-foot">
          <button type="submit" className="acct-btn acct-btn-ghost">
            Sign out
          </button>
        </form>
      </main>
      <Footer />
    </>
  );
}

function Dashboard({ view, mobile }: { view: AccountView; mobile: string }) {
  const cutoff = hmLabel(view.cutoffTime);
  return (
    <>
      <TodayCard view={view} cutoff={cutoff} />

      <section className="acct-card" aria-labelledby="plans-h">
        <h2 id="plans-h">Your plans</h2>
        <Guard s={view.plans}>
          {(plans) =>
            plans.length === 0 ? (
              <p>
                No plan on this number yet. <Link href="/subscribe">Start one</Link>.
              </p>
            ) : (
              <div className="acct-list">
                {plans.map((p) => (
                  <PlanCard key={p.id} plan={p} view={view} mobile={mobile} cutoff={cutoff} />
                ))}
              </div>
            )
          }
        </Guard>
      </section>

      <HistorySection view={view} />
      <TicketsSection view={view} />
      <CreditsSection view={view} />
      <RefundsSection view={view} />

      <section className="acct-card" aria-labelledby="addr-h">
        <h2 id="addr-h">Delivery address</h2>
        <Guard s={view.profile}>
          {(profile) => {
            const live = view.plans.ok ? view.plans.data.find((p) => p.live) : undefined;
            return (
              <>
                {profile.address || live?.address ? (
                  <p>
                    Now: <strong>{profile.address ?? live?.address}</strong>
                    {profile.landmark ? ` (near ${profile.landmark})` : ''}
                  </p>
                ) : null}
                <details className="acct-details">
                  <summary>Change address</summary>
                  <AddressForm
                    initial={{
                      location: profile.location,
                      addressParts: profile.addressParts ?? { house: '' },
                      landmark: profile.landmark ?? '',
                      instructions: profile.instructions ?? '',
                    }}
                  />
                </details>
              </>
            );
          }}
        </Guard>
      </section>

      <section className="acct-card" aria-labelledby="prefs-h">
        <h2 id="prefs-h">Preferences</h2>
        <Guard s={view.profile}>
          {(profile) => (
            <PreferencesForm
              initial={{
                whatsappOptIn: profile.whatsappOptIn,
                missedDeliveryPreference: profile.missedDeliveryPreference,
                notifyDailyDelivered: profile.notifyDailyDelivered,
                lang: profile.lang,
              }}
            />
          )}
        </Guard>
      </section>

      <section className="acct-card" aria-labelledby="tl-h">
        <h2 id="tl-h">Activity</h2>
        <Guard s={view.timeline}>
          {(items) =>
            items.length === 0 ? (
              <p className="acct-muted">Nothing yet.</p>
            ) : (
              <ol className="acct-timeline">
                {items.map((i) => (
                  <li key={i.id}>
                    <time dateTime={i.at}>{at(i.at)}</time>
                    <span>{i.label}</span>
                  </li>
                ))}
              </ol>
            )
          }
        </Guard>
      </section>

      <p className="acct-muted acct-help">
        Need help? <Help />.
      </p>
    </>
  );
}

function DeliveryLine({ d }: { d: DeliveryView }) {
  return (
    <li className={`acct-dline acct-s-${d.state}`}>
      <span className="acct-dline-main">
        {litres(d.litres)} {d.kind} — {d.label}
      </span>
      {d.resolutionLabel ? <span className="acct-muted">{d.resolutionLabel}</span> : null}
      {d.photoUrl ? (
        <a href={d.photoUrl} target="_blank" rel="noopener noreferrer" className="acct-link">
          Doorstep photo
        </a>
      ) : null}
    </li>
  );
}

function TodayCard({ view, cutoff }: { view: AccountView; cutoff: string }) {
  return (
    <section className="acct-card acct-today" aria-labelledby="today-h">
      <h2 id="today-h">Today, {dl(view.today)}</h2>
      <Guard s={view.plans}>
        {(plans) => {
          const live = plans.filter((p) => p.live || p.today.rows.length > 0 || p.tomorrow.rows.length > 0);
          if (live.length === 0) {
            return (
              <p>
                No deliveries today. <Link href="/subscribe">Start a plan</Link>.
              </p>
            );
          }
          return (
            <>
              {(['today', 'tomorrow'] as const).map((which) => {
                const date = which === 'today' ? view.today : view.tomorrow;
                const lines = live.flatMap((p) => {
                  const day = p[which];
                  if (day.paused) return [{ key: `${p.id}-p`, node: <li key={`${p.id}-p`}>{kindName(p.kind)} — paused</li> }];
                  return day.rows.map((r) => ({ key: r.id, node: <DeliveryLine key={r.id} d={r} /> }));
                });
                return (
                  <div key={which} className="acct-day">
                    <h3>
                      {which === 'today' ? 'Today' : 'Tomorrow'}
                      <span className="acct-muted"> · {dl(date)}</span>
                    </h3>
                    {lines.length === 0 ? (
                      <p className="acct-muted">No delivery.</p>
                    ) : (
                      <ul className="acct-lines">{lines.map((l) => l.node)}</ul>
                    )}
                  </div>
                );
              })}
              <p className="acct-muted">
                Deliveries arrive between {hmLabel(view.windowStart)} and {hmLabel(view.windowEnd)}. Changes for a day
                close at {cutoff} the day before; the first day you can still change is{' '}
                <strong>{dl(view.firstOpenDate)}</strong>.
              </p>
            </>
          );
        }}
      </Guard>
    </section>
  );
}

const STATUS_LABEL: Record<PlanView['status'], string> = {
  scheduled: 'Starts soon',
  active: 'Active',
  completed: 'Finished',
  cancelled: 'Cancelled',
};

function PlanCard({ plan: p, view, mobile, cutoff }: { plan: PlanView; view: AccountView; mobile: string; cutoff: string }) {
  return (
    <article className={`acct-plan acct-plan-${p.status}`}>
      <header className="acct-plan-head">
        <h3>
          {kindName(p.kind)} milk · {litres(p.litresPerDay)} a day
        </h3>
        <span className="acct-badge">{STATUS_LABEL[p.status]}</span>
      </header>
      <dl className="acct-facts">
        <dt>Dates</dt>
        <dd>
          {dl(p.startDate)} → {dl(p.endDate)}
        </dd>
        {p.live && (
          <>
            <dt>Days left</dt>
            <dd>{p.daysLeft}</dd>
            <dt>Pause days</dt>
            <dd>
              {p.pauseRemainingDays} of {p.pauseAllowanceDays} left
            </dd>
          </>
        )}
        <dt>Delivered</dt>
        <dd>
          {p.daysDelivered} of {p.daysTotal} days
        </dd>
        {p.status === 'cancelled' && p.cancelEffectiveDate && (
          <>
            <dt>Stopped from</dt>
            <dd>{dl(p.cancelEffectiveDate)}</dd>
          </>
        )}
        {p.address && (
          <>
            <dt>Address</dt>
            <dd>{p.address}</dd>
          </>
        )}
      </dl>

      {p.renewal ? (
        <p className="acct-ok">
          Renewal booked
          {p.renewal.startDate ? `: ${dl(p.renewal.startDate)} → ${dl(p.renewal.endDate)}` : ''}.
        </p>
      ) : null}

      {p.canRenew ? (
        <p className="acct-row">
          <span>{p.daysLeft === 0 ? 'Your last delivery is done.' : `Only ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left.`}</span>
          <Link className="acct-btn" href={`/subscribe?renew=${p.id}`}>
            Renew this plan
          </Link>
        </p>
      ) : null}

      {p.live ? (
        <div className="acct-actions">
          <details className="acct-details">
            <summary>Pause days</summary>
            <PauseCalendar subscriptionId={p.id} cutoffLabel={cutoff} />
          </details>
          <details className="acct-details">
            <summary>Extra milk</summary>
            <ExtraMilk subscriptionId={p.id} planKind={p.kind} firstOpenDate={view.firstOpenDate} mobile={mobile} />
          </details>
          <details className="acct-details">
            <summary>Cancel plan</summary>
            <CancelSubscription subscriptionId={p.id} />
          </details>
        </div>
      ) : null}
    </article>
  );
}

function HistorySection({ view }: { view: AccountView }) {
  const openTicketFor = new Set(
    view.tickets.ok ? view.tickets.data.filter((t) => t.status === 'open' && t.deliveryId).map((t) => t.deliveryId) : [],
  );
  return (
    <section className="acct-card" aria-labelledby="hist-h">
      <h2 id="hist-h">Recent deliveries</h2>
      <Guard s={view.history}>
        {(rows) =>
          rows.length === 0 ? (
            <p className="acct-muted">No deliveries yet.</p>
          ) : (
            <ul className="acct-history">
              {rows.map((d) => (
                <li key={d.id} className={`acct-s-${d.state}`}>
                  <div className="acct-hist-row">
                    <strong>{dl(d.date)}</strong>
                    <span>
                      {litres(d.litres)} {d.kind} — {d.label}
                    </span>
                  </div>
                  {d.resolutionLabel ? <p className="acct-muted">{d.resolutionLabel}</p> : null}
                  <div className="acct-row">
                    {d.photoUrl ? (
                      <a href={d.photoUrl} target="_blank" rel="noopener noreferrer" className="acct-link">
                        Doorstep photo
                      </a>
                    ) : null}
                    {d.reportable && d.id && !openTicketFor.has(d.id) ? (
                      <details className="acct-details acct-details-inline">
                        <summary>Report a problem</summary>
                        <ReportProblem deliveryId={d.id} date={d.date} />
                      </details>
                    ) : null}
                    {d.id && openTicketFor.has(d.id) ? <span className="acct-muted">Reported — we are on it</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Guard>
    </section>
  );
}

function TicketsSection({ view }: { view: AccountView }) {
  return (
    <section className="acct-card" aria-labelledby="tk-h">
      <h2 id="tk-h">Your reports</h2>
      <Guard s={view.tickets}>
        {(tickets) =>
          tickets.length === 0 ? (
            <p className="acct-muted">You have not reported any problems. Use “Report a problem” on a delivery above.</p>
          ) : (
            <ul className="acct-lines">
              {tickets.map((t) => (
                <li key={t.id}>
                  <div className="acct-hist-row">
                    <strong>{t.kindLabel}</strong>
                    <span className="acct-badge">{t.status === 'open' ? 'Open' : 'Resolved'}</span>
                  </div>
                  <p className="acct-muted">
                    {t.deliveryDate ? `Delivery of ${dl(t.deliveryDate)} · ` : ''}reported {at(t.createdAt)}
                  </p>
                  {t.note ? <p>“{t.note}”</p> : null}
                  {t.resolution ? (
                    <p className="acct-ok">
                      Our reply: {t.resolution}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        }
      </Guard>
    </section>
  );
}

function CreditsSection({ view }: { view: AccountView }) {
  return (
    <section className="acct-card" aria-labelledby="cr-h">
      <h2 id="cr-h">Credit</h2>
      <Guard s={view.credits}>
        {(c) => (
          <>
            <p className="acct-big">{formatINR(c.balancePaise)}</p>
            <p className="acct-muted">
              Used automatically for extra milk and renewals.
              {c.refundablePaise > 0 ? ` ${formatINR(c.refundablePaise)} of it is refundable if you cancel.` : ''}
            </p>
            {c.entries.length === 0 ? (
              <p className="acct-muted">No credit activity yet.</p>
            ) : (
              <ul className="acct-lines">
                {c.entries.map((e) => (
                  <li key={e.id} className="acct-hist-row">
                    <span>
                      {e.label}
                      <span className="acct-muted"> · {at(e.at)}</span>
                      {e.note ? <span className="acct-muted"> · {e.note}</span> : null}
                    </span>
                    <strong className={e.amountPaise < 0 ? 'acct-neg' : 'acct-pos'}>
                      {e.amountPaise < 0 ? '−' : '+'}
                      {formatINR(Math.abs(e.amountPaise))}
                    </strong>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Guard>
    </section>
  );
}

function RefundsSection({ view }: { view: AccountView }) {
  // A refund list is only worth a section when there is (or might be) one.
  if (view.refunds.ok && view.refunds.data.length === 0) return null;
  return (
    <section className="acct-card" aria-labelledby="rf-h">
      <h2 id="rf-h">Refunds</h2>
      <Guard s={view.refunds}>
        {(refunds) => (
          <ul className="acct-lines">
            {refunds.map((r) => (
              <li key={r.id}>
                <div className="acct-hist-row">
                  <strong>{formatINR(r.amountPaise)}</strong>
                  <span className="acct-badge">{r.statusLabel}</span>
                </div>
                <p className="acct-muted">
                  Created {at(r.createdAt)}
                  {r.upiId ? ` · to ${r.upiId}` : ''}
                  {r.breakdown.toCreditPaise > 0 ? ` · plus ${formatINR(r.breakdown.toCreditPaise)} added to your credit` : ''}
                </p>
                {r.needsUpi ? (
                  <>
                    <p>
                      This payment is too old to refund to your card or bank automatically. Give us a UPI id and we will
                      send it there.
                    </p>
                    <RefundUpi refundId={r.id} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Guard>
    </section>
  );
}
