'use client';

import { useRef, useState } from 'react';

/**
 * One-time-code sign-in, used by the pay step (and the renewal gate). Moved out of
 * the old single-file page unchanged in behaviour: request → verify → onSignedIn.
 */
export default function OtpForm({
  onSignedIn,
  intro = 'A one-time code confirms your number — there is no password to choose or forget.',
}: {
  onSignedIn: (mobile: string) => void;
  intro?: string;
}) {
  const [stage, setStage] = useState<'mobile' | 'code'>('mobile');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const mobileValid = /^[6-9]\d{9}$/.test(mobile);

  const requestCode = async () => {
    if (!mobileValid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mobile }),
      });
      const body = (await res.json().catch(() => ({}))) as { devCode?: string; error?: string; missing?: string[]; retryAfter?: number };
      if (res.status === 503) {
        setErr(
          `Sign-in codes are not configured on this server${body.missing?.length ? ` (missing ${body.missing.join(', ')})` : ''}. Please call us to set up delivery.`,
        );
        return;
      }
      if (!res.ok) {
        setErr(body.error ?? 'Could not send a code. Please try again.');
        return;
      }
      setDevCode(body.devCode ?? null);
      setStage('code');
      setTimeout(() => codeRef.current?.focus(), 0);
    } catch {
      setErr('Could not send a code. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mobile, code }),
      });
      if (res.status === 503) {
        setErr('The account service is unavailable right now. Please try again shortly.');
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(body.error ?? 'That code is not valid or has expired. Request a fresh one.');
        return;
      }
      onSignedIn(mobile);
    } catch {
      setErr('Could not verify the code. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sb-pay">
      <p className="sb-secondary">{intro}</p>

      {err ? (
        <div className="sb-notice is-err" role="alert">
          <span className="sb-dot" aria-hidden="true" />
          <span>{err}</span>
        </div>
      ) : null}

      {stage === 'mobile' ? (
        <>
          <div className="sb-field">
            <label htmlFor="sb-mobile">Mobile number</label>
            <input
              id="sb-mobile"
              className="sb-input"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="10-digit mobile"
              value={mobile}
              maxLength={10}
              onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
              onKeyDown={(e) => e.key === 'Enter' && void requestCode()}
            />
          </div>
          <button type="button" className={`sb-btn${busy ? ' is-busy' : ''}`} onClick={requestCode} disabled={!mobileValid || busy}>
            {busy ? (
              <>
                <span className="sb-spinner" aria-hidden="true" /> Sending…
              </>
            ) : (
              'Send code'
            )}
          </button>
        </>
      ) : (
        <>
          <div className="sb-field">
            <label htmlFor="sb-code">Enter the 6-digit code sent to {mobile}</label>
            <input
              id="sb-code"
              ref={codeRef}
              className="sb-input sb-otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="••••••"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => e.key === 'Enter' && void verify()}
            />
          </div>
          {devCode ? (
            <p className="sb-hint">
              Development mode, no SMS provider — your code is <b>{devCode}</b>.
            </p>
          ) : null}
          <button type="button" className={`sb-btn${busy ? ' is-busy' : ''}`} onClick={verify} disabled={code.length !== 6 || busy}>
            {busy ? (
              <>
                <span className="sb-spinner" aria-hidden="true" /> Verifying…
              </>
            ) : (
              'Verify & continue'
            )}
          </button>
          <button
            type="button"
            className="sb-linkbtn"
            onClick={() => {
              setStage('mobile');
              setCode('');
              setDevCode(null);
              setErr(null);
            }}
          >
            Use a different number
          </button>
        </>
      )}
    </div>
  );
}
