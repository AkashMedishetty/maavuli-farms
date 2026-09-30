'use client';

import { useEffect, useRef, useState } from 'react';
import { CONTACT } from '@/lib/content';
import { formatMobile } from './lib';

/** A new code can be asked for after this long (the server also rate-limits). */
const RESEND_AFTER_S = 30;

/**
 * One-time-code sign-in, used by the pay screen (and the renewal gate):
 * request → verify → onSignedIn.
 *
 * The code is confirmed as soon as all 6 digits are in (a code pasted from WhatsApp
 * needs no extra tap); the button stays for anyone who prefers it. A fresh code can
 * be requested after 30 seconds.
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
  const [sentAt, setSentAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const codeRef = useRef<HTMLInputElement>(null);
  /** the last 6-digit code auto-submitted, so a wrong one is not retried on its own */
  const autoTried = useRef('');

  const mobileValid = /^[6-9]\d{9}$/.test(mobile);
  const waitS = Math.max(0, RESEND_AFTER_S - Math.floor((now - sentAt) / 1000));

  // Tick once a second while the resend countdown runs.
  useEffect(() => {
    if (stage !== 'code' || waitS === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [stage, waitS]);

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
        // Env-var names are shown to developers only, never to the public (§9).
        setErr(
          process.env.NODE_ENV !== 'production'
            ? `Sign-in codes are not configured on this server${body.missing?.length ? ` (missing ${body.missing.join(', ')})` : ''}. Please call us to set up delivery.`
            : `Online sign-up is paused — call ${CONTACT.phones[0] ?? 'us'} and we will set up your delivery.`,
        );
        return;
      }
      if (!res.ok) {
        setErr(body.error ?? 'Could not send a code. Please try again.');
        return;
      }
      setDevCode(body.devCode ?? null);
      setCode('');
      autoTried.current = '';
      setSentAt(Date.now());
      setNow(Date.now());
      setStage('code');
      setTimeout(() => codeRef.current?.focus(), 0);
    } catch {
      setErr('Could not send a code. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string = code) => {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mobile, code: value }),
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

  const onCode = (raw: string) => {
    const v = raw.replace(/\D/g, '').slice(0, 6);
    setCode(v);
    if (v.length === 6 && autoTried.current !== v) {
      autoTried.current = v;
      void verify(v);
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
        <form
          className="sb-otp-row"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void requestCode();
          }}
        >
          <div className="sb-field">
            <label htmlFor="sb-mobile">Your mobile number</label>
            <div className="sb-tel">
              <span aria-hidden="true">+91</span>
              <input
                id="sb-mobile"
                className="sb-input"
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                placeholder="10 digits"
                value={mobile}
                onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').replace(/^(?:91|0)(?=\d{10})/, '').slice(0, 10))}
              />
            </div>
          </div>
          <button type="submit" className={`sb-btn${busy ? ' is-busy' : ''}`} disabled={!mobileValid || busy}>
            {busy ? (
              <>
                <span className="sb-spinner" aria-hidden="true" /> Sending…
              </>
            ) : (
              'Send code'
            )}
          </button>
        </form>
      ) : (
        <form
          className="sb-otp-row"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <div className="sb-field">
            <label htmlFor="sb-code">Enter the 6-digit code we sent on WhatsApp to {formatMobile(mobile)}</label>
            <input
              id="sb-code"
              ref={codeRef}
              className="sb-input sb-otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="••••••"
              value={code}
              onChange={(e) => onCode(e.target.value)}
            />
          </div>
          {devCode ? (
            <p className="sb-hint">
              Test mode — your code is <b>{devCode}</b>.
            </p>
          ) : null}
          <button type="submit" className={`sb-btn${busy ? ' is-busy' : ''}`} disabled={code.length !== 6 || busy}>
            {busy ? (
              <>
                <span className="sb-spinner" aria-hidden="true" /> Checking…
              </>
            ) : (
              'Confirm code'
            )}
          </button>
          <p className="sb-secondary">
            <button type="button" className="sb-linkbtn" disabled={waitS > 0 || busy} onClick={() => void requestCode()}>
              {waitS > 0 ? `Send a new code in ${waitS}s` : 'Send a new code'}
            </button>
            <span aria-hidden="true">·</span>
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
          </p>
        </form>
      )}
    </div>
  );
}
