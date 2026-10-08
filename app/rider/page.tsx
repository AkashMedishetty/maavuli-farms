import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getPrincipal } from '@/lib/roles';
import { NotConfiguredError } from '@/lib/db';
import {
  issueOtp,
  clientIpFrom,
  verifyOtp,
  InvalidMobileError,
  OtpDeliveryError,
  RateLimitError,
  SmsNotConfiguredError,
  VerifyError,
} from '@/lib/auth';
import RiderApp from '@/components/rider/RiderApp';
import { SubmitButton } from '@/components/SubmitButton';
import { normalizeMobile } from '@/lib/models';

export const metadata = { title: 'Maavuli Rider' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/* ------------------------------------------------------------ server actions */

/*
 * A development/demo code is shown from a short-lived httpOnly cookie bound to the
 * mobile, never from the URL (browser history, proxy and request logs).
 */
const DEV_CODE_COOKIE = 'mv_dev_code';
const DEV_CODE_PATH = '/rider';

async function setDevCode(mobile: string, code: string | undefined): Promise<void> {
  const { cookies } = await import('next/headers');
  const jar = await cookies();
  const m = normalizeMobile(mobile);
  const base = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: DEV_CODE_PATH };
  if (code && m) jar.set(DEV_CODE_COOKIE, `${m}.${code}`, { ...base, maxAge: 5 * 60 });
  else jar.set(DEV_CODE_COOKIE, '', { ...base, maxAge: 0 });
}

async function readDevCode(mobile: string): Promise<string | undefined> {
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(DEV_CODE_COOKIE)?.value ?? '';
  const [m, code] = raw.split('.');
  const want = normalizeMobile(mobile);
  return want && m === want && code && /^\d{6}$/.test(code) ? code : undefined;
}

async function requestCodeAction(formData: FormData): Promise<void> {
  'use server';
  const mobile = String(formData.get('mobile') ?? '');
  let target: string;
  try {
    const { headers } = await import('next/headers');
    const result = await issueOtp(mobile, { ip: clientIpFrom(await headers()) });
    await setDevCode(mobile, result.devCode);
    target = `/rider?step=code&m=${encodeURIComponent(mobile)}`;
  } catch (err) {
    if (err instanceof InvalidMobileError) target = '/rider?err=mobile';
    else if (err instanceof RateLimitError) target = `/rider?err=rate&retry=${err.retryAfterSeconds}`;
    else if (err instanceof SmsNotConfiguredError) target = '/rider?err=sms';
    else if (err instanceof OtpDeliveryError) target = '/rider?err=send';
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
    await setDevCode(mobile, undefined);
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
  send: 'We could not send your code just now. Wait a minute and try again.',
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
  const devCode = step === 'code' ? await readDevCode(mobile) : undefined;

  return (
    <main className="rider-main">
      <header className="rider-head">
        <h1>Delivery partner sign-in</h1>
        <p className="rsub">A one-time code goes to your mobile — no password.</p>
      </header>

      {dbDown ? (
        <div className="rerror" role="alert">
          The service is temporarily unavailable. Please try again shortly.
        </div>
      ) : (
        <>
          {err ? (
            <div className="rerror" role="alert">
              {err}
            </div>
          ) : null}

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
              <SubmitButton className="rbtn primary" pendingLabel="Sending…">
                Send code
              </SubmitButton>
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
                <p className="rsub" style={{ color: '#f59e0b' }}>
                  Development mode — your code is <strong>{devCode}</strong>.
                </p>
              ) : null}
              <SubmitButton className="rbtn primary" pendingLabel="Checking…">
                Verify &amp; sign in
              </SubmitButton>
              <p className="rsub" style={{ marginTop: 12 }}>
                <Link href="/rider">Use a different number</Link>
              </p>
            </form>
          )}
        </>
      )}
    </main>
  );
}
