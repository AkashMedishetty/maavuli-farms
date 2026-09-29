import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getPrincipal } from '@/lib/roles';
import { NotConfiguredError } from '@/lib/db';
import {
  issueOtp,
  verifyOtp,
  InvalidMobileError,
  RateLimitError,
  SmsNotConfiguredError,
  VerifyError,
} from '@/lib/auth';
import RiderApp from '@/components/rider/RiderApp';

export const metadata = { title: 'Maavuli Rider' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/* ------------------------------------------------------------ server actions */

async function requestCodeAction(formData: FormData): Promise<void> {
  'use server';
  const mobile = String(formData.get('mobile') ?? '');
  let target: string;
  try {
    const result = await issueOtp(mobile);
    const dev = result.devCode ? `&dev=${result.devCode}` : '';
    target = `/rider?step=code&m=${encodeURIComponent(mobile)}${dev}`;
  } catch (err) {
    if (err instanceof InvalidMobileError) target = '/rider?err=mobile';
    else if (err instanceof RateLimitError) target = `/rider?err=rate&retry=${err.retryAfterSeconds}`;
    else if (err instanceof SmsNotConfiguredError) target = '/rider?err=sms';
    else if (err instanceof NotConfiguredError) target = '/rider?err=db';
    else throw err;
  }
  redirect(target);
}

async function verifyCodeAction(formData: FormData): Promise<void> {
  'use server';
  const mobile = String(formData.get('mobile') ?? '');
  const code = String(formData.get('code') ?? '');
  let target = '/rider';
  try {
    await verifyOtp(mobile, code);
  } catch (err) {
    if (err instanceof VerifyError) target = `/rider?step=code&m=${encodeURIComponent(mobile)}&err=code`;
    else if (err instanceof NotConfiguredError) target = '/rider?err=db';
    else throw err;
  }
  redirect(target);
}

const ERR_COPY: Record<string, string> = {
  mobile: 'Enter a valid 10-digit mobile number.',
  code: 'That code is not valid or has expired. Request a fresh one.',
  sms: 'Sign-in codes are not switched on yet. Ask ops to enable SMS.',
  db: 'Could not reach the service just now. Try again shortly.',
  rate: 'Too many code requests. Wait a little before trying again.',
  notrider: 'This number is not registered as a delivery partner. Ask ops to add you.',
};

/* -------------------------------------------------------------------- views */

export default async function RiderPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;

  let principal: Awaited<ReturnType<typeof getPrincipal>> = null;
  let dbDown = false;
  try {
    principal = await getPrincipal();
  } catch (err) {
    if (err instanceof NotConfiguredError) dbDown = true;
    else throw err;
  }

  // Signed in AND a rider → the app.
  if (principal?.riderId) {
    return <RiderApp riderName={principal.riderName ?? null} />;
  }

  // Signed in but NOT a rider → honest message, not the sign-in form.
  const errKey = principal && !principal.riderId ? 'notrider' : one(sp.err);

  const step = one(sp.step) === 'code' ? 'code' : 'mobile';
  const mobile = one(sp.m) ?? '';
  const err = errKey ? ERR_COPY[errKey] : undefined;
  const devCode = one(sp.dev);

  return (
    <main className="rider-main">
      <header className="rider-head">
        <h1>Delivery partner sign-in</h1>
        <p className="sub">A one-time code goes to your mobile — no password.</p>
      </header>

      {dbDown ? (
        <div className="rerror">The service is temporarily unavailable. Please try again shortly.</div>
      ) : (
        <>
          {err ? <div className="rerror">{err}</div> : null}

          {step === 'mobile' ? (
            <form action={requestCodeAction}>
              <label className="rfield">
                <span>Mobile number</span>
                <input
                  className="rinput"
                  type="tel"
                  name="mobile"
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder="10-digit mobile"
                  defaultValue={mobile}
                  required
                />
              </label>
              <button type="submit" className="rbtn primary">
                Send code
              </button>
            </form>
          ) : (
            <form action={verifyCodeAction}>
              <input type="hidden" name="mobile" value={mobile} />
              <label className="rfield">
                <span>Enter the 6-digit code sent to {mobile || 'your mobile'}</span>
                <input
                  className="rinput"
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
                <p className="sub" style={{ color: '#f59e0b' }}>
                  Development mode — your code is <strong>{devCode}</strong>.
                </p>
              ) : null}
              <button type="submit" className="rbtn primary">
                Verify &amp; sign in
              </button>
              <p className="sub" style={{ marginTop: 12 }}>
                <Link href="/rider">Use a different number</Link>
              </p>
            </form>
          )}
        </>
      )}
    </main>
  );
}
