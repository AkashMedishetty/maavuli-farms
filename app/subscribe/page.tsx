'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { PRODUCTS, QUANTITIES, TENURES, quote, formatINR, type MilkKind } from '@/lib/pricing';
import { CONTACT } from '@/lib/content';
import NavPanel from '@/components/NavPanel';
import RazorpayCheckout, { type CheckoutOrder } from '@/components/RazorpayCheckout';
import './subscribe.css';

/**
 * The subscription funnel, redesigned.
 *
 * Order (a deliberate change kept from the prior build): pincode FIRST, so nobody
 * configures a ₹35,190 year and only THEN learns we do not deliver to them. Then
 * milk -> quantity -> term, with the running price always visible in the sticky
 * rail on the right (and pinned to the top on mobile). Price is revealed as it is
 * built, not hidden until the end.
 *
 * Every price comes from lib/pricing.quote(); not one rupee figure is typed here.
 *
 * Honesty rules that shape the UI:
 *  · Serviceability has THREE distinct states — deliver / do NOT deliver / could
 *    not check — plus a developer 503 that names the missing env vars. The DB is
 *    absent in this environment, so "could not check" / 503 is the expected path.
 *  · Checkout amount is NEVER sent; the server recomputes from (kind, qty, tenure).
 *  · Payment is confirmed by the Razorpay webhook, not the browser — the success
 *    screen says "payment received, confirming" and points to /account.
 *  · If Razorpay is unconfigured (503), the Pay button is visibly DISABLED with a
 *    plain explanation and the env vars named — never hidden, never a dead button.
 */

type Step = 'area' | 'milk' | 'qty' | 'term' | 'details' | 'checkout';
const STEP_ORDER: readonly Step[] = ['area', 'milk', 'qty', 'term', 'details', 'checkout'];
const STEP_LABELS: Record<Step, string> = {
  area: 'Area',
  milk: 'Milk',
  qty: 'Daily amount',
  term: 'Duration',
  details: 'Address',
  checkout: 'Confirm',
};

/**
 * The value step 1 captures. Deliberately a small object, not a bare pincode
 * string, so the serviceability model can move from pincode → geo point without a
 * refactor: today only `pincode` is populated; when a map pin is added later, it
 * sets `lat`/`lng` (and optionally a human `note`) on this same shape and
 * `serviceabilityQuery()` below is the single place that turns it into the request.
 * The backend already accepts both `?pincode=` and `?lat=&lng=`.
 */
interface LocationInput {
  pincode?: string;
  lat?: number;
  lng?: number;
  note?: string;
}

/** Name, address and the optional exact doorstep — what the rider actually needs. */
interface DeliveryInput {
  name: string;
  address: string;
  landmark: string;
  lat?: number;
  lng?: number;
}

/** The one place that maps a LocationInput to the /api/serviceability query. */
function serviceabilityQuery(loc: LocationInput): string | null {
  if (typeof loc.lat === 'number' && typeof loc.lng === 'number') {
    return `lat=${loc.lat}&lng=${loc.lng}`;
  }
  const clean = (loc.pincode ?? '').replace(/\D/g, '');
  if (clean.length === 6) return `pincode=${clean}`;
  return null; // not enough to check yet
}

/** Serviceability outcomes, kept as distinct states per the contract. */
type Area =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'yes'; pincode: string; area?: string }
  | { kind: 'no'; pincode: string }
  | { kind: 'unknown'; pincode: string; message: string } // published-nowhere-yet
  | { kind: 'down' } // configured but unreachable / network error
  | { kind: 'unconfigured'; missing: string[] }; // 503, names the env vars

/** Auth (OTP) state for the pay step. */
type Auth =
  | { kind: 'unknown' } // /api/auth/me not resolved yet
  | { kind: 'out' }
  | { kind: 'in'; mobile: string }
  | { kind: 'down'; missing?: string[] }; // account service 503

/** Checkout / payment state. */
type Pay =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'ready'; order: CheckoutOrder }
  | { kind: 'unconfigured'; missing: string[] }
  | { kind: 'unserviceable'; pincode: string }
  | { kind: 'error'; message: string }
  | { kind: 'received' }   // paid, but our confirmation call did not land — the webhook is the backstop
  | { kind: 'active'; startDate: string | null; endDate: string | null }; // confirmed server-side

export default function SubscribePage() {
  const [step, setStep] = useState<Step>('area');

  const [loc, setLoc] = useState<LocationInput>({});
  /* Who and where. A rider cannot deliver to a pincode, so this is required before
     payment; the exact point is optional because plenty of people decline the
     browser permission and refusing their order over that would be absurd. */
  const [details, setDetails] = useState<DeliveryInput>({ name: '', address: '', landmark: '' });
  const [area, setArea] = useState<Area>({ kind: 'idle' });

  const [milk, setMilk] = useState<MilkKind | null>(null);
  const [qty, setQty] = useState<string | null>(null);
  const [term, setTerm] = useState<string | null>(null);

  const q = useMemo(
    () => (milk && qty && term ? quote(milk, qty, term) : null),
    [milk, qty, term],
  );

  const idx = STEP_ORDER.indexOf(step);
  const progressPct = Math.round((idx / (STEP_ORDER.length - 1)) * 100);

  // The confirmed delivery pincode, if any — only a "yes" is authoritative.
  const confirmedPincode = area.kind === 'yes' ? area.pincode : null;

  // --- serviceability check ------------------------------------------------
  const checkArea = useCallback(async () => {
    const query = serviceabilityQuery(loc);
    if (!query) return;
    setArea({ kind: 'checking' });
    try {
      const res = await fetch(`/api/serviceability?${query}`, { cache: 'no-store' });
      if (res.status === 503) {
        const body = (await res.json().catch(() => ({}))) as { missing?: string[] };
        setArea({ kind: 'unconfigured', missing: body.missing ?? [] });
        setStep('milk');
        return;
      }
      if (!res.ok) {
        setArea({ kind: 'down' });
        setStep('milk');
        return;
      }
      const body = (await res.json()) as {
        pincode?: string;
        serviceable: boolean;
        unknown?: boolean;
        area?: string;
        message?: string;
      };
      // The label shown to the user: the returned pincode, or the human note / a
      // coordinate string when the check was geo-based. Keeps the three-state
      // contract intact regardless of which input form was used.
      const label =
        body.pincode ??
        loc.pincode ??
        loc.note ??
        (typeof loc.lat === 'number' && typeof loc.lng === 'number'
          ? `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`
          : 'your location');
      if (body.serviceable) setArea({ kind: 'yes', pincode: label, area: body.area });
      else if (body.unknown)
        setArea({
          kind: 'unknown',
          pincode: label,
          message: body.message ?? 'Our delivery area is not published yet.',
        });
      else setArea({ kind: 'no', pincode: label });
      setStep('milk');
    } catch {
      // Network failure is an outage, not a "no" — keep them distinct.
      setArea({ kind: 'down' });
      setStep('milk');
    }
  }, [loc]);

  // --- reset when starting over -------------------------------------------
  const restart = () => {
    setStep('area');
    setLoc({});
    setArea({ kind: 'idle' });
    setMilk(null);
    setQty(null);
    setTerm(null);
    // pay state lives in CheckoutStep; leaving that step unmounts it, so there is
    // nothing to reset here.
  };

  // === render =============================================================
  return (
    <>
      <NavPanel />
      <main className="sb">
        <div className="sb-grid">
          {/* -------- left: the flow -------- */}
          <div className="sb-flow">
            <div className="sb-flow-progress">
              <Progress step={step} idx={idx} pct={progressPct} />
            </div>

            <div className="sb-flow-step">
            {step === 'area' && (
              <AreaStep
                loc={loc}
                setLoc={setLoc}
                area={area}
                onCheck={checkArea}
              />
            )}

            {step === 'milk' && (
              <MilkStep
                area={area}
                selected={milk}
                onPick={(k) => {
                  setMilk(k);
                  setStep('qty');
                }}
                onBack={() => setStep('area')}
              />
            )}

            {step === 'qty' && milk && (
              <QtyStep
                milk={milk}
                selected={qty}
                onPick={(id) => {
                  setQty(id);
                  setStep('term');
                }}
                onBack={() => setStep('milk')}
              />
            )}

            {step === 'term' && milk && qty && (
              <TermStep
                milk={milk}
                qty={qty}
                selected={term}
                onPick={(id) => {
                  setTerm(id);
                  setStep('details');
                }}
                onBack={() => setStep('qty')}
              />
            )}

            {step === 'details' && (
              <DetailsStep
                value={details}
                onChange={setDetails}
                pincode={confirmedPincode}
                onNext={() => setStep('checkout')}
                onBack={() => setStep('term')}
              />
            )}

            {step === 'checkout' && q && (
              <CheckoutStep
                q={q}
                milk={milk!}
                qty={qty!}
                term={term!}
                area={area}
                confirmedPincode={confirmedPincode}
                details={details}
                onBack={() => setStep('details')}
                onRestart={restart}
              />
            )}

            <p className="sb-foot">
              <Link href="/plans">See every plan and price →</Link>
            </p>
            </div>
          </div>

          {/* -------- right: sticky running summary + price -------- */}
          <aside className="sb-rail" aria-label="Your plan so far">
            <SummaryCard
              milk={milk}
              qty={qty}
              term={term}
              q={q}
              area={area}
            />
          </aside>
        </div>
      </main>
    </>
  );
}

// ------------------------------------------------------------------ Progress

function Progress({ step, idx, pct }: { step: Step; idx: number; pct: number }) {
  return (
    <div className="sb-progress">
      <ol className="sb-steps">
        {STEP_ORDER.map((s, n) => (
          <li
            key={s}
            className={n === idx ? 'is-current' : n < idx ? 'is-done' : undefined}
            aria-current={s === step ? 'step' : undefined}
          >
            <span className="sb-num" aria-hidden="true">
              {n < idx ? '✓' : n + 1}
            </span>
            <span className="sb-label">{STEP_LABELS[s]}</span>
          </li>
        ))}
      </ol>
      <div
        className="sb-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`Step ${idx + 1} of ${STEP_ORDER.length}`}
      >
        <div className="sb-bar-fill" style={{ width: `${Math.max(pct, 6)}%` }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Step: area

function AreaStep({
  loc,
  setLoc,
  area,
  onCheck,
}: {
  loc: LocationInput;
  setLoc: (v: LocationInput) => void;
  area: Area;
  onCheck: () => void;
}) {
  const pin = loc.pincode ?? '';
  const valid = serviceabilityQuery(loc) !== null;
  const checking = area.kind === 'checking';
  return (
    <section className="sb-panel">
      <p className="eyebrow">Step 1 of 5</p>
      <h1>Where should it arrive?</h1>
      <p className="sb-lead">
        We check delivery first, before anything else — so you never build a plan we
        cannot bring to your door.
      </p>
      <div className="sb-pin">
        <input
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={6}
          placeholder="6-digit pincode"
          value={pin}
          onChange={(e) =>
            // Edit the pincode field of the location object. A later map pin sets
            // lat/lng on this same object instead — the rest of the flow is unchanged.
            setLoc({ ...loc, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })
          }
          onKeyDown={(e) => e.key === 'Enter' && valid && onCheck()}
          aria-label="Delivery pincode"
        />
        <button
          type="button"
          className={`sb-btn${checking ? ' is-busy' : ''}`}
          onClick={onCheck}
          disabled={!valid || checking}
        >
          {checking ? (
            <>
              <span className="sb-spinner" aria-hidden="true" /> Checking…
            </>
          ) : (
            'Check'
          )}
        </button>
      </div>
      <p className="sb-hint">
        Your pincode is the authoritative check — a district guess is not good enough for
        a daily delivery.
      </p>
    </section>
  );
}

// --------------------------------------------------------- serviceability notice

function AreaNotice({ area }: { area: Area }) {
  switch (area.kind) {
    case 'yes':
      return (
        <div className="sb-notice is-ok" role="status">
          <span className="sb-dot" aria-hidden="true" />
          <span>
            <b>Yes — we deliver to {area.pincode}.</b>
            {area.area ? ` (${area.area})` : ''} Build your plan below.
          </span>
        </div>
      );
    case 'no':
      return (
        <div className="sb-notice" role="status">
          <span className="sb-dot" aria-hidden="true" />
          <span>
            We do not deliver to <b>{area.pincode}</b> yet. You can still build a plan and
            we will reach out when we cover your area — nothing is charged.
          </span>
        </div>
      );
    case 'unknown':
      return (
        <div className="sb-notice is-warn" role="status">
          <span className="sb-dot" aria-hidden="true" />
          <span>
            {area.message} We will confirm <b>{area.pincode}</b> with you directly before
            anything is charged.
          </span>
        </div>
      );
    case 'down':
      return (
        <div className="sb-notice is-err" role="status">
          <span className="sb-dot" aria-hidden="true" />
          <span>
            We could not check your delivery area just now — that is a service hiccup on
            our side, not a “no”. Please try the pincode again in a moment.
          </span>
        </div>
      );
    case 'unconfigured':
      return (
        <div className="sb-dev" role="status">
          <strong>Developer notice — serviceability is not configured (503).</strong> The
          delivery-area service needs these environment variables:
          <ul>
            {area.missing.length ? (
              area.missing.map((m) => (
                <li key={m}>
                  <code>{m}</code>
                </li>
              ))
            ) : (
              <li>(none reported)</li>
            )}
          </ul>
        </div>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------------ Step: milk

function MilkStep({
  area,
  selected,
  onPick,
  onBack,
}: {
  area: Area;
  selected: MilkKind | null;
  onPick: (k: MilkKind) => void;
  onBack: () => void;
}) {
  return (
    <section className="sb-panel">
      <AreaNotice area={area} />
      <p className="eyebrow">Step 2 of 5</p>
      <h1>Which milk?</h1>
      <div className="sb-choices sb-two">
        {PRODUCTS.map((p) => (
          <button
            key={p.kind}
            type="button"
            className={`sb-choice${selected === p.kind ? ' is-selected' : ''}`}
            onClick={() => onPick(p.kind)}
            aria-pressed={selected === p.kind}
          >
            <span className="sb-choice-name">{p.label}</span>
            {/* breedClaim stays null until the client confirms A2/desi — asserting
                it unverified would be inventing a fact. */}
            {p.breedClaim ? (
              <span className="sb-choice-sub">{p.breedClaim}</span>
            ) : (
              <span className="sb-choice-rate">
                from {formatINR(quote(p.kind, 'one', '1m').perLitrePaise)} / litre
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="sb-nav">
        <button type="button" className="sb-back" onClick={onBack}>
          ← Change pincode
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------- Step: qty

function QtyStep({
  milk,
  selected,
  onPick,
  onBack,
}: {
  milk: MilkKind;
  selected: string | null;
  onPick: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <section className="sb-panel">
      <p className="eyebrow">Step 3 of 5</p>
      <h1>How much, each day?</h1>
      <div className="sb-choices sb-two">
        {QUANTITIES.map((x) => {
          // 1-month price at this quantity, as an anchor the customer can compare.
          const tq = quote(milk, x.id, '1m');
          return (
            <button
              key={x.id}
              type="button"
              className={`sb-choice${selected === x.id ? ' is-selected' : ''}`}
              onClick={() => onPick(x.id)}
              aria-pressed={selected === x.id}
            >
              <span className="sb-choice-name">{x.label}</span>
              <span className="sb-choice-rate">
                {formatINR(tq.finalPaise)} / month to start
              </span>
            </button>
          );
        })}
      </div>
      <div className="sb-nav">
        <button type="button" className="sb-back" onClick={onBack}>
          ← Back to milk
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Step: term

function TermStep({
  milk,
  qty,
  selected,
  onPick,
  onBack,
}: {
  milk: MilkKind;
  qty: string;
  selected: string | null;
  onPick: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <section className="sb-panel">
      <p className="eyebrow">Step 4 of 5</p>
      <h1>For how long?</h1>
      <p className="sb-lead">Longer terms are prepaid once and discounted. No auto-renewal.</p>
      <div className="sb-choices sb-terms">
        {TENURES.map((t) => {
          const tq = quote(milk, qty, t.id);
          return (
            <button
              key={t.id}
              type="button"
              className={`sb-choice${selected === t.id ? ' is-selected' : ''}`}
              onClick={() => onPick(t.id)}
              aria-pressed={selected === t.id}
            >
              <span className="sb-choice-name">{t.label}</span>
              <span className="sb-choice-rate">{formatINR(tq.finalPaise)} total</span>
              {t.discountPct > 0 ? (
                <span className="sb-choice-off">save {t.discountPct}%</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="sb-nav">
        <button type="button" className="sb-back" onClick={onBack}>
          ← Back to amount
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------- Step: checkout

function CheckoutStep({
  q,
  milk,
  qty,
  term,
  area,
  confirmedPincode,
  details,
  onBack,
  onRestart,
}: {
  q: ReturnType<typeof quote>;
  milk: MilkKind;
  qty: string;
  term: string;
  area: Area;
  confirmedPincode: string | null;
  /** captured in the details step; the server requires name + address */
  details: DeliveryInput;
  onBack: () => void;
  onRestart: () => void;
}) {
  const [auth, setAuth] = useState<Auth>({ kind: 'unknown' });
  const [pay, setPay] = useState<Pay>({ kind: 'idle' });

  const planLabel = `${PRODUCTS.find((p) => p.kind === milk)?.label} · ${
    QUANTITIES.find((x) => x.id === qty)?.label
  } · ${TENURES.find((t) => t.id === term)?.label}`;

  // resolve session once
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        if (res.status === 503) {
          const body = (await res.json().catch(() => ({}))) as { missing?: string[] };
          if (alive) setAuth({ kind: 'down', missing: body.missing });
          return;
        }
        const body = (await res.json()) as { authenticated: boolean; mobile?: string };
        if (alive)
          setAuth(
            body.authenticated && body.mobile
              ? { kind: 'in', mobile: body.mobile }
              : { kind: 'out' },
          );
      } catch {
        if (alive) setAuth({ kind: 'down' });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const startCheckout = useCallback(
    async (mobile: string) => {
      if (!confirmedPincode) return;
      setPay({ kind: 'creating' });
      try {
        // NOTE: no amount is sent — the server recomputes from (kind, qty, tenure).
        const res = await fetch('/api/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mobile,
            kind: milk,
            quantityId: qty,
            tenureId: term,
            pincode: confirmedPincode,
            name: details.name.trim(),
            address: details.address.trim(),
            ...(details.landmark.trim() ? { landmark: details.landmark.trim() } : {}),
            ...(details.lat !== undefined && details.lng !== undefined
              ? { lat: details.lat, lng: details.lng }
              : {}),
          }),
        });
        if (res.status === 503) {
          const body = (await res.json().catch(() => ({}))) as { missing?: string[] };
          setPay({ kind: 'unconfigured', missing: body.missing ?? [] });
          return;
        }
        if (res.status === 409) {
          setPay({ kind: 'unserviceable', pincode: confirmedPincode });
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setPay({ kind: 'error', message: body.error ?? 'Could not start checkout.' });
          return;
        }
        const order = (await res.json()) as CheckoutOrder;
        setPay({ kind: 'ready', order });
      } catch {
        setPay({ kind: 'error', message: 'Could not reach checkout. Please try again.' });
      }
    },
    [confirmedPincode, milk, qty, term],
  );

  return (
    <section className="sb-panel">
      <p className="eyebrow">Step 5 of 5</p>
      <h1>Confirm &amp; pay.</h1>

      {/* Payment can only proceed on a CONFIRMED serviceable pincode. Every other
          area state routes to "leave your details" instead of a live payment. */}
      {confirmedPincode ? (
        <>
          <p className="sb-lead">
            {planLabel} — <b>{formatINR(q.finalPaise)}</b> prepaid for {q.days} days,
            delivered to {confirmedPincode}.
          </p>

          {pay.kind === 'active' ? (
            <SubscriptionActive startDate={pay.startDate} endDate={pay.endDate} />
          ) : pay.kind === 'received' ? (
            <PaymentReceived />
          ) : (
            <PayBlock
              auth={auth}
              setAuth={setAuth}
              pay={pay}
              setPay={setPay}
              planLabel={planLabel}
              startCheckout={startCheckout}
              onError={(message) => setPay({ kind: 'error', message })}
            />
          )}
        </>
      ) : (
        <NotServiceableCheckout area={area} planLabel={planLabel} total={q.finalPaise} />
      )}

      <div className="sb-nav">
        <button type="button" className="sb-back" onClick={onBack}>
          ← Back to duration
        </button>
        <button type="button" className="sb-back" onClick={onRestart}>
          ↺ Start again
        </button>
      </div>
    </section>
  );
}

// ---- pay block: OTP sign-in (if needed) then Razorpay -----------------------

function PayBlock({
  auth,
  setAuth,
  pay,
  setPay,
  planLabel,
  startCheckout,
  onError,
}: {
  auth: Auth;
  setAuth: (a: Auth) => void;
  pay: Pay;
  setPay: (p: Pay) => void;
  planLabel: string;
  startCheckout: (mobile: string) => void;
  onError: (m: string) => void;
}) {
  if (auth.kind === 'unknown') {
    return (
      <p className="sb-secondary">
        <span className="sb-spinner" aria-hidden="true" /> Checking your sign-in…
      </p>
    );
  }

  if (auth.kind === 'down') {
    return (
      <div className="sb-dev" role="status">
        <strong>Developer notice — the account service is not configured (503).</strong>{' '}
        Sign-in by OTP needs its environment variables:
        <ul>
          {(auth.missing ?? []).length ? (
            auth.missing!.map((m) => (
              <li key={m}>
                <code>{m}</code>
              </li>
            ))
          ) : (
            <li>(none reported)</li>
          )}
        </ul>
        <p style={{ marginTop: '0.6rem' }}>
          To arrange delivery meanwhile, call{' '}
          <a href={`tel:${CONTACT.phones[0]?.replace(/\s/g, '')}`}>{CONTACT.phones[0]}</a>.
        </p>
      </div>
    );
  }

  if (auth.kind === 'out') {
    return <OtpForm onSignedIn={(mobile) => setAuth({ kind: 'in', mobile })} onError={onError} />;
  }

  // auth.kind === 'in'
  return (
    <div className="sb-pay">
      <p className="sb-secondary">
        Signed in as {auth.mobile}. <SwitchNumber setAuth={setAuth} setPay={setPay} />
      </p>

      {pay.kind === 'unconfigured' ? (
        <>
          <button type="button" className="sb-btn" disabled>
            Pay — unavailable
          </button>
          <div className="sb-dev" role="status">
            <strong>Payments are not configured (503).</strong> Razorpay needs these
            environment variables before the Pay button can go live:
            <ul>
              {pay.missing.length ? (
                pay.missing.map((m) => (
                  <li key={m}>
                    <code>{m}</code>
                  </li>
                ))
              ) : (
                <li>(none reported)</li>
              )}
            </ul>
          </div>
        </>
      ) : pay.kind === 'ready' ? (
        <RazorpayCheckout
          order={pay.order}
          mobile={auth.mobile}
          planLabel={planLabel}
          onPaid={async (r) => {
            /*
             * Confirm the payment server-side straight away.
             *
             * Activation used to be webhook-only, which meant the customer saw
             * Razorpay say "success" while the site could only promise the
             * subscription would appear "within a minute" — and on a loopback dev
             * host the webhook can never arrive at all, so it never appeared.
             * /api/payments/verify re-checks the HMAC and activates through the
             * same guarded transition the webhook uses, so whichever lands first
             * wins and the other is a no-op.
             *
             * If this call fails we do NOT claim failure: the money moved. We fall
             * back to the honest "confirming" message and let the webhook finish.
             */
            try {
              const res = await fetch('/api/payments/verify', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  razorpay_order_id: r.razorpay_order_id,
                  razorpay_payment_id: r.razorpay_payment_id,
                  razorpay_signature: r.razorpay_signature,
                }),
              });
              const body = await res.json().catch(() => ({}));
              if (res.ok && body.subscriptionId) {
                setPay({
                  kind: 'active',
                  startDate: body.startDate ?? null,
                  endDate: body.endDate ?? null,
                });
                return;
              }
            } catch {
              // fall through to the webhook-backstop message
            }
            setPay({ kind: 'received' });
          }}
          onError={onError}
        />
      ) : pay.kind === 'unserviceable' ? (
        <div className="sb-notice is-err" role="status">
          <span className="sb-dot" aria-hidden="true" />
          <span>
            We are not able to deliver to {pay.pincode} after all. Nothing was charged —
            please check the pincode.
          </span>
        </div>
      ) : pay.kind === 'error' ? (
        <>
          <div className="sb-notice is-err" role="status">
            <span className="sb-dot" aria-hidden="true" />
            <span>{pay.message}</span>
          </div>
          <button type="button" className="sb-btn" onClick={() => startCheckout(auth.mobile)}>
            Try again
          </button>
        </>
      ) : (
        <button
          type="button"
          className={`sb-btn${pay.kind === 'creating' ? ' is-busy' : ''}`}
          onClick={() => startCheckout(auth.mobile)}
          disabled={pay.kind === 'creating'}
        >
          {pay.kind === 'creating' ? (
            <>
              <span className="sb-spinner" aria-hidden="true" /> Starting…
            </>
          ) : (
            'Continue to payment'
          )}
        </button>
      )}
    </div>
  );
}

function SwitchNumber({
  setAuth,
  setPay,
}: {
  setAuth: (a: Auth) => void;
  setPay: (p: Pay) => void;
}) {
  return (
    <button
      type="button"
      className="sb-linkbtn"
      onClick={async () => {
        try {
          await fetch('/api/auth/logout', { method: 'POST' });
        } catch {
          /* logout is best-effort here; the form below re-authenticates anyway */
        }
        setPay({ kind: 'idle' });
        setAuth({ kind: 'out' });
      }}
    >
      Use a different number
    </button>
  );
}

// ---- OTP form ---------------------------------------------------------------

function OtpForm({
  onSignedIn,
  onError,
}: {
  onSignedIn: (mobile: string) => void;
  onError: (m: string) => void;
}) {
  const [stage, setStage] = useState<'mobile' | 'code'>('mobile');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const mobileValid = mobile.replace(/\D/g, '').length === 10;

  const requestCode = async () => {
    if (!mobileValid) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mobile }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        devCode?: string;
        error?: string;
        missing?: string[];
      };
      if (res.status === 503) {
        onError(
          `Sign-in by SMS is not configured${
            body.missing?.length ? ` (missing ${body.missing.join(', ')})` : ''
          }. Please call us to set up delivery.`,
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
      setErr('Could not send a code. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (code.replace(/\D/g, '').length !== 6) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mobile, code }),
      });
      if (res.status === 503) {
        onError('The account service is unavailable right now. Please try again shortly.');
        return;
      }
      if (!res.ok) {
        setErr('That code is not valid or has expired. Request a fresh one.');
        return;
      }
      onSignedIn(mobile);
    } catch {
      setErr('Could not verify the code. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sb-pay">
      <p className="sb-secondary">
        A one-time code confirms your number — there is no password to choose or forget.
      </p>

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
              autoComplete="tel"
              placeholder="10-digit mobile"
              value={mobile}
              maxLength={10}
              onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
              onKeyDown={(e) => e.key === 'Enter' && mobileValid && requestCode()}
            />
          </div>
          <button
            type="button"
            className={`sb-btn${busy ? ' is-busy' : ''}`}
            onClick={requestCode}
            disabled={!mobileValid || busy}
          >
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
              onKeyDown={(e) => e.key === 'Enter' && verify()}
            />
          </div>
          {devCode ? (
            <p className="sb-hint">
              Development mode, no SMS provider — your code is <b>{devCode}</b>.
            </p>
          ) : null}
          <button
            type="button"
            className={`sb-btn${busy ? ' is-busy' : ''}`}
            onClick={verify}
            disabled={code.replace(/\D/g, '').length !== 6 || busy}
          >
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

/* ------------------------------------------------------------- details ---- */

/**
 * Who the milk is for and where it goes.
 *
 * Name and address are REQUIRED — a rider cannot deliver to "500047", and a
 * Hyderabad pincode can span several kilometres. The exact point is OPTIONAL and
 * deliberately so: many people decline the browser permission, and refusing their
 * order over that would be absurd. When they do share it, it becomes the
 * authoritative serviceability check against the drawn zones and the rider gets a
 * one-tap maps link.
 *
 * Note on geolocation: the browser only exposes it on a secure origin. 127.0.0.1
 * counts as secure, so it works locally — but over a plain-HTTP LAN address (testing
 * from a phone on the same wifi) the permission is refused by the browser, not by
 * this code. The UI says so rather than looking broken.
 */
function DetailsStep({
  value,
  onChange,
  pincode,
  onNext,
  onBack,
}: {
  value: DeliveryInput;
  onChange: (v: DeliveryInput) => void;
  pincode: string | null;
  onNext: () => void;
  onBack: () => void;
}) {
  const [locating, setLocating] = useState(false);
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const [zoneMsg, setZoneMsg] = useState<{ kind: 'yes' | 'no' | 'unknown' | 'error'; text: string } | null>(null);

  const nameOk = value.name.trim().length >= 2;
  const addressOk = value.address.trim().length >= 10;
  const hasPoint = value.lat !== undefined && value.lng !== undefined;

  const set = (patch: Partial<DeliveryInput>) => onChange({ ...value, ...patch });

  function useMyLocation() {
    if (!('geolocation' in navigator)) {
      setLocMsg('This browser cannot share a location. Your address alone is fine.');
      return;
    }
    setLocating(true);
    setLocMsg(null);
    setZoneMsg(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lng = Number(pos.coords.longitude.toFixed(6));
        set({ lat, lng });
        setLocating(false);
        setLocMsg(`Pinned to ${lat.toFixed(5)}, ${lng.toFixed(5)} — accurate to about ${Math.round(pos.coords.accuracy)} m.`);
        // Confirm the pin is in a zone straight away rather than at payment time.
        try {
          const r = await fetch(`/api/serviceability?lat=${lat}&lng=${lng}`);
          const b = await r.json().catch(() => ({}));
          if (!r.ok) setZoneMsg({ kind: 'error', text: 'We could not check that pin just now. You can still continue.' });
          else if (b.unknown) setZoneMsg({ kind: 'unknown', text: 'Our delivery zones are not published yet — we will confirm before charging you.' });
          else if (b.serviceable) setZoneMsg({ kind: 'yes', text: `Yes — that is inside ${b.zone ?? 'our delivery area'}.` });
          else setZoneMsg({ kind: 'no', text: 'That pin is outside our delivery area at the moment.' });
        } catch {
          setZoneMsg({ kind: 'error', text: 'We could not check that pin just now. You can still continue.' });
        }
      },
      (err) => {
        setLocating(false);
        // Distinguish the three real cases; "denied" is a choice, not a fault.
        const why =
          err.code === err.PERMISSION_DENIED
            ? 'You declined location access. That is fine — your written address is enough.'
            : err.code === err.POSITION_UNAVAILABLE
              ? 'Your device could not get a fix. Your written address is enough.'
              : 'That took too long. Your written address is enough.';
        setLocMsg(why);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  }

  return (
    <div className="sb-step" aria-labelledby="sb-details-h">
      <h2 id="sb-details-h">Where should we deliver?</h2>
      <p className="sb-lead">
        {pincode ? `Pincode ${pincode} confirmed. ` : ''}
        We need a name and the full address — the bottle is handed to a person at a door,
        not to a pincode.
      </p>

      <div className="sb-fields">
        <label className="sb-field">
          <span>Name for the delivery</span>
          <input
            value={value.name}
            onChange={(e) => set({ name: e.target.value })}
            autoComplete="name"
            maxLength={80}
            placeholder="Who should we ask for?"
          />
        </label>

        <label className="sb-field">
          <span>Full address</span>
          <textarea
            value={value.address}
            onChange={(e) => set({ address: e.target.value })}
            autoComplete="street-address"
            rows={3}
            maxLength={400}
            placeholder="Flat or house number, building, street, area"
          />
          {!addressOk && value.address.length > 0 ? (
            <em className="sb-fieldnote">Please include the flat or house number and the street.</em>
          ) : null}
        </label>

        <label className="sb-field">
          <span>Landmark <i>(optional, but it helps)</i></span>
          <input
            value={value.landmark}
            onChange={(e) => set({ landmark: e.target.value })}
            maxLength={140}
            placeholder="Opposite the water tank, blue gate…"
          />
        </label>
      </div>

      <div className="sb-locbox">
        <div className="sb-locrow">
          <button type="button" className="cta" onClick={useMyLocation} disabled={locating}>
            {locating ? 'Finding you…' : hasPoint ? 'Update my location' : 'Use my current location'}
          </button>
          {hasPoint ? (
            <button
              type="button"
              className="sb-back"
              onClick={() => { set({ lat: undefined, lng: undefined }); setLocMsg(null); setZoneMsg(null); }}
            >
              Remove pin
            </button>
          ) : null}
        </div>
        <p className="sb-help">
          Optional. It gives the rider an exact doorstep instead of a street name — useful
          in lanes that maps do not label.
        </p>
        {locMsg ? <p className="sb-help">{locMsg}</p> : null}
        {zoneMsg ? (
          <p className={`sb-notice${zoneMsg.kind === 'no' ? ' is-err' : ''}`} role="status">
            <span className="sb-dot" aria-hidden="true" />
            <span>{zoneMsg.text}</span>
          </p>
        ) : null}
      </div>

      <div className="sb-actions">
        <button type="button" className="cta" onClick={onNext} disabled={!nameOk || !addressOk}>
          Continue to payment
        </button>
        <button type="button" className="sb-back" onClick={onBack}>
          ← Back
        </button>
      </div>
      {/* Say WHY the button is not ready. A greyed control with no explanation is the
          most common reason a form feels broken. */}
      {!nameOk || !addressOk ? (
        <p className="sb-hint">
          {!nameOk && !addressOk
            ? 'Add a name and a full address to continue.'
            : !nameOk
              ? 'Add a name for the delivery to continue.'
              : 'Add the flat or house number and street to continue.'}
        </p>
      ) : null}
    </div>
  );
}

function SubscriptionActive({
  startDate,
  endDate,
}: {
  startDate: string | null;
  endDate: string | null;
}) {
  return (
    <div className="sb-success">
      <span className="sb-check" aria-hidden="true">
        ✓
      </span>
      <h2>Your subscription is live.</h2>
      <p className="sb-lead">
        {startDate && endDate ? (
          <>
            Deliveries run from <b>{startDate}</b> to <b>{endDate}</b>.
          </>
        ) : (
          <>Your plan is active.</>
        )}{' '}
        You can pause, skip a day or check the schedule in{' '}
        <Link href="/account" className="sb-linkbtn">
          My Deliveries
        </Link>
        .
      </p>
      <Link className="cta" href="/account">
        Go to my deliveries
      </Link>
    </div>
  );
}

function PaymentReceived() {
  return (
    <div className="sb-success">
      <span className="sb-check" aria-hidden="true">
        ✓
      </span>
      <h2>Payment received.</h2>
      <p className="sb-lead">
        We are confirming your payment with the gateway now. Your subscription appears in{' '}
        <Link href="/account" className="sb-linkbtn">
          My Deliveries
        </Link>{' '}
        once it is confirmed — usually within a minute.
      </p>
      <Link className="cta" href="/account">
        Go to my deliveries
      </Link>
    </div>
  );
}

function NotServiceableCheckout({
  area,
  planLabel,
  total,
}: {
  area: Area;
  planLabel: string;
  total: number;
}) {
  // No live payment when we cannot confirm delivery. Offer to capture interest.
  const pin =
    area.kind === 'no' || area.kind === 'unknown'
      ? area.pincode
      : area.kind === 'yes'
        ? area.pincode
        : '';
  const body = encodeURIComponent(
    `Pincode: ${pin}\nPlan: ${planLabel}\nTotal: ${formatINR(total)}`,
  );
  const subject = encodeURIComponent('Subscription interest — Maavuli');
  return (
    <>
      <AreaNotice area={area} />
      <p className="sb-lead">
        We are not taking payment for {pin || 'this area'} yet — we will only charge once
        delivery is confirmed. Send us this plan and we will set it up with you directly.
      </p>
      <a className="sb-btn" href={`mailto:${CONTACT.email}?subject=${subject}&body=${body}`}>
        Send this plan
      </a>
      <p className="sb-secondary">
        or call{' '}
        <a href={`tel:${CONTACT.phones[0]?.replace(/\s/g, '')}`}>{CONTACT.phones[0]}</a>
      </p>
    </>
  );
}

// ------------------------------------------------------------- summary rail

function SummaryCard({
  milk,
  qty,
  term,
  q,
  area,
}: {
  milk: MilkKind | null;
  qty: string | null;
  term: string | null;
  q: ReturnType<typeof quote> | null;
  area: Area;
}) {
  const milkLabel = milk ? PRODUCTS.find((p) => p.kind === milk)?.label : null;
  const qtyLabel = qty ? QUANTITIES.find((x) => x.id === qty)?.label : null;
  const termLabel = term ? TENURES.find((t) => t.id === term)?.label : null;

  const areaLine =
    area.kind === 'yes'
      ? `Delivers to ${area.pincode}`
      : area.kind === 'no'
        ? `${area.pincode} — not yet`
        : area.kind === 'unknown'
          ? `${area.pincode} — to confirm`
          : null;

  return (
    <div className="sb-card">
      <p className="sb-card-eyebrow">Your plan</p>

      <div className="sb-price" aria-live="polite">
        {q ? (
          <>
            <span className="sb-amount">{formatINR(q.finalPaise)}</span>
            <span className="sb-per">
              {formatINR(q.perLitrePaise)} / litre · {q.days} days prepaid
            </span>
          </>
        ) : (
          <>
            <span className="sb-amount is-pending">—</span>
            <span className="sb-per">Choose a milk, amount and term</span>
          </>
        )}
      </div>

      <ul className="sb-lines">
        <li className={areaLine ? undefined : 'is-empty'}>
          <span>Area</span>
          <b>{areaLine ?? 'not checked'}</b>
        </li>
        <li className={milkLabel ? undefined : 'is-empty'}>
          <span>Milk</span>
          <b>{milkLabel ?? 'not chosen'}</b>
        </li>
        <li className={qtyLabel ? undefined : 'is-empty'}>
          <span>Each day</span>
          <b>{qtyLabel ?? 'not chosen'}</b>
        </li>
        <li className={termLabel ? undefined : 'is-empty'}>
          <span>Term</span>
          <b>{termLabel ?? 'not chosen'}</b>
        </li>
        {q ? (
          <>
            <li>
              <span>Total milk</span>
              <b>{q.litres} litres</b>
            </li>
            {q.savingPaise > 0 ? (
              <>
                <li className="sb-strike">
                  <span>Full price</span>
                  <b>{formatINR(q.originalPaise)}</b>
                </li>
                <li className="sb-save">
                  <span>You save ({q.discountPct}%)</span>
                  <b>{formatINR(q.savingPaise)}</b>
                </li>
              </>
            ) : null}
          </>
        ) : null}
      </ul>

      <p className="sb-rail-note">
        Prices are fixed-term and prepaid — one payment, no auto-renewal. Delivery window
        and daily cutoff are{' '}
        <span className="sb-nowrap">
          <span className="pending">to be announced</span>.
        </span>
      </p>
    </div>
  );
}
