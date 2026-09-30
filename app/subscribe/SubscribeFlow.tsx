'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PRODUCTS, QUANTITIES, TENURES, formatINR, pauseDaysFor, quote, type MilkKind } from '@/lib/pricing';
import { CONTACT } from '@/lib/content';
import LocationPicker, { type PickedLocation } from '@/components/LocationPicker';
import { ACCURACY_OK_M } from '@/components/LocationPickerShared';
import RazorpayCheckout, { type CheckoutOrder, type RazorpayResponse } from '@/components/RazorpayCheckout';
import OtpForm from './OtpForm';
import { clearDraft, readDraft, writeDraft } from './draft';
import {
  EMPTY_ADDRESS,
  FLOW_STEPS,
  addDaysYMD,
  addressProblems,
  callApi,
  composeAddress,
  dateLabel,
  formatMobile,
  isFlowStep,
  isOutsideZone,
  istToday,
  newKey,
  postJson,
  stepForFail,
  type AddressForm,
  type FlowStep,
} from './lib';
import type { ApiFail, DayRuleLabels, PreviewJSON, RenewalProp } from './types';

/**
 * The subscription funnel, in three screens.
 *
 *   1 where — the exact doorstep on a map, checked against the delivery zones; the
 *             door details appear only once the pin is somewhere we deliver
 *   2 plan  — milk, daily amount and length on ONE screen with every price in view,
 *             and the first delivery date from the server
 *   3 pay   — one receipt (server-priced, real dates) BEFORE sign-in; then the
 *             one-time code; then Razorpay → verify
 *
 * Progress survives a refresh (draft.ts — this browser tab only), and the phone's
 * Back button moves between the screens (one history entry per screen) instead of
 * leaving the page. "Edit" on the receipt jumps to a screen, and its Continue comes
 * straight back to pay.
 *
 * Every rupee figure comes from lib/pricing.quote() or the server's
 * /api/checkout/preview. The client never sends an amount.
 *
 * Honest states: serviceability keeps yes / no / not-published / down /
 * unconfigured distinct; every fetch has loading → error → data; an API error is
 * shown on the screen that caused it (a pin outside every zone goes back to the map,
 * a date that closed goes back to the plan).
 */

type Step = FlowStep;
const STEP_LABELS: Record<Step, string> = { where: 'Address', plan: 'Your milk', pay: 'Pay' };
/** The button under an error on the Pay screen says where it will take you. */
const FIX_LABEL: Record<Step, string> = { where: 'Change the address', plan: 'Change the plan or date', pay: 'Try again' };

type Area =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'yes'; zone: string | null }
  | { kind: 'no' }
  | { kind: 'unknown' }
  | { kind: 'down' }
  | { kind: 'unconfigured'; missing: string[] };

type StepErrors = Partial<Record<Step, ApiFail>>;

interface StartChoice {
  mode: 'earliest' | 'later';
  date: string;
}

interface PlanBody {
  purpose: 'new' | 'renewal';
  kind: MilkKind;
  quantityId: string;
  tenureId: string;
  renewsSubscriptionId?: string;
  startDate?: string;
}

type Ready = Extract<RenewalProp, { kind: 'ready' }>;
type PayKey = { sig: string; key: string } | null;

/* ------------------------------------------------------------------ helpers -- */

function detailsToForm(r: Ready): AddressForm {
  const d = r.details;
  const ap = d.addressParts;
  return {
    ...EMPTY_ADDRESS,
    name: d.name,
    house: ap?.house ?? '',
    floor: ap?.floor ?? '',
    building: ap?.building ?? '',
    society: ap?.society ?? (ap ? '' : d.address),
    area: ap?.area ?? '',
    pincode: ap?.pincode ?? '',
    landmark: d.landmark ?? '',
    instructions: d.instructions ?? '',
  };
}

/** A renewal lands on the receipt when its plan still matches; otherwise on what is missing. */
function initialStepFor(r: Ready | null): Step {
  if (!r || !r.details.location) return 'where';
  return r.quantityId && r.tenureId ? 'pay' : 'plan';
}

const milkName = (k: MilkKind) => PRODUCTS.find((p) => p.kind === k)?.label ?? k;
/** "½ litre" / "1 litre" from "½ Litre / day". */
const qtyName = (id: string) => (QUANTITIES.find((x) => x.id === id)?.label ?? id).replace(/\s*\/\s*day$/i, '').replace('Litre', 'litre');
const termName = (id: string) => TENURES.find((t) => t.id === id)?.label ?? id;

/** "a, b and c". */
function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/* =================================================================== flow ==== */

export default function SubscribeFlow({ renewal, rules }: { renewal: RenewalProp; rules: DayRuleLabels }) {
  const router = useRouter();
  const ready = renewal.kind === 'ready' ? renewal : null;

  const [step, setStep] = useState<Step>(() => initialStepFor(ready));
  const [pin, setPinState] = useState<PickedLocation | null>(ready?.details.location ? { ...ready.details.location } : null);
  const [area, setArea] = useState<Area>({ kind: 'idle' });
  const [addr, setAddr] = useState<AddressForm>(ready ? detailsToForm(ready) : EMPTY_ADDRESS);
  const [milk, setMilk] = useState<MilkKind | null>(ready?.milk ?? null);
  const [qty, setQty] = useState<string | null>(ready?.quantityId ?? null);
  const [term, setTerm] = useState<string | null>(ready?.tenureId ?? null);
  const [start, setStart] = useState<StartChoice>({ mode: 'earliest', date: '' });
  const [errors, setErrors] = useState<StepErrors>({});
  const [reachedPay, setReachedPay] = useState(() => initialStepFor(ready) === 'pay');
  const [payKey, setPayKey] = useState<PayKey>(null);
  /** paid (or payment received): stop saving, hide the stepper */
  const [finished, setFinished] = useState(false);
  /** false until this tab's saved draft has been read */
  const [restored, setRestored] = useState(false);

  const stepRef = useRef(step);
  stepRef.current = step;
  const finishedRef = useRef(finished);
  finishedRef.current = finished;
  const routerRef = useRef(router);
  routerRef.current = router;
  /** which screens the current inputs allow (set each render, read by the Back/Forward handler) */
  const reachRef = useRef<(s: Step) => boolean>(() => true);
  const focusHeading = useRef(false);

  /* ---- resume a half-finished sign-up in this tab (new plans only: a renewal is
     rebuilt from the server every time) ---- */
  useEffect(() => {
    if (!ready) {
      const d = readDraft();
      if (d) {
        setPinState(d.pin);
        setAddr(d.addr);
        setMilk(d.milk);
        setQty(d.qty);
        setTerm(d.term);
        setStart(d.start);
        setReachedPay(d.reachedPay);
        setPayKey(d.payKey);
        // Back after a reload lands on an older entry of this page: that entry's
        // screen wins over the one saved last.
        const hs = (window.history.state as { sbStep?: unknown } | null)?.sbStep;
        let s: Step = isFlowStep(hs) ? hs : d.step;
        const pinUsable = !!d.pin && !(d.pin.accuracyM !== undefined && d.pin.accuracyM > ACCURACY_OK_M);
        if (!pinUsable || (s !== 'where' && Object.keys(addressProblems(d.addr)).length > 0)) s = 'where';
        else if (s === 'pay' && !(d.milk && d.qty && d.term)) s = 'plan';
        setStep(s);
      }
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- the phone's Back / Forward move between the three screens ---- */
  useEffect(() => {
    if (!restored) return;
    try {
      window.history.replaceState({ ...(window.history.state ?? {}), sbStep: stepRef.current }, '');
    } catch {
      /* history unavailable: Back simply leaves the page, as before */
    }
    const onPop = (e: PopStateEvent) => {
      // Paid: the older screens are over. Back takes the customer to their deliveries.
      if (finishedRef.current) {
        routerRef.current.replace('/account');
        return;
      }
      const s = (e.state as { sbStep?: unknown } | null)?.sbStep;
      if (!isFlowStep(s)) return;
      // Forward can land on a screen the inputs no longer allow (a moved pin, a cleared
      // choice): show the furthest screen that is still open instead.
      const target: Step = reachRef.current(s) ? s : reachRef.current('plan') ? 'plan' : 'where';
      if (target !== s) {
        try {
          window.history.replaceState({ ...(window.history.state ?? {}), sbStep: target }, '');
        } catch {
          /* the screen still changes */
        }
      }
      focusHeading.current = true;
      if (target === 'pay') setReachedPay(true);
      setStep(target);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [restored]);

  /* ---- save progress (this tab only; cleared once paid) ---- */
  useEffect(() => {
    if (!restored || ready || finished) return;
    writeDraft({
      step,
      pin: pin
        ? {
            lat: pin.lat,
            lng: pin.lng,
            ...(pin.accuracyM !== undefined ? { accuracyM: pin.accuracyM } : {}),
            ...(pin.label ? { label: pin.label } : {}),
          }
        : null,
      addr,
      milk,
      qty,
      term,
      start,
      reachedPay,
      payKey,
    });
  }, [restored, ready, finished, step, pin, addr, milk, qty, term, start, reachedPay, payKey]);

  const q = useMemo(() => (milk && qty && term ? quote(milk, qty, term) : null), [milk, qty, term]);

  /* ---- serviceability: re-checked whenever the pin moves ---- */
  const checkSeq = useRef(0);
  useEffect(() => {
    if (!pin) {
      setArea({ kind: 'idle' });
      return;
    }
    const seq = ++checkSeq.current;
    setArea({ kind: 'checking' });
    void (async () => {
      const r = await callApi<{ serviceable: boolean; unknown?: boolean; zone?: string; message?: string }>(
        `/api/serviceability?lat=${pin.lat}&lng=${pin.lng}`,
      );
      if (seq !== checkSeq.current) return; // a newer pin superseded this check
      if (!r.ok) {
        if (r.fail.status === 503 && r.fail.missing?.length) setArea({ kind: 'unconfigured', missing: r.fail.missing });
        else setArea({ kind: 'down' });
        return;
      }
      if (r.data.serviceable) setArea({ kind: 'yes', zone: r.data.zone ?? null });
      else if (r.data.unknown) setArea({ kind: 'unknown' });
      else setArea({ kind: 'no' });
    })();
  }, [pin]);

  const recheck = () => setPinState((p) => (p ? { ...p } : p));

  /* ---- navigation ---- */
  const go = useCallback((s: Step, opts: { replace?: boolean } = {}) => {
    focusHeading.current = true;
    if (s === 'pay') setReachedPay(true);
    if (s !== stepRef.current) {
      try {
        const state = { ...(window.history.state ?? {}), sbStep: s };
        if (opts.replace) window.history.replaceState(state, '');
        else window.history.pushState(state, '');
      } catch {
        /* the screen still changes; only Back will not return to it */
      }
    }
    setStep(s);
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, []);

  // After a screen change, move focus to its heading so keyboard and screen-reader
  // users are not left on <body> (the button they pressed unmounted).
  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    const h = document.querySelector<HTMLHeadingElement>('main.sb h1');
    if (!h) return;
    if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }, [step]);

  /* ---- errors ---- */
  const clearError = (s: Step) => setErrors((e) => (e[s] ? { ...e, [s]: undefined } : e));
  const routeFail = useCallback(
    (f: ApiFail) => {
      const s = stepForFail(f);
      setErrors((e) => ({ ...e, [s]: f }));
      if (f.code === 'date_locked') setStart({ mode: 'earliest', date: '' });
      if (isOutsideZone(f)) setArea({ kind: 'no' });
      go(s, { replace: true });
    },
    [go],
  );

  const setPin = (p: PickedLocation) => {
    clearError('where');
    setPinState(p);
    // Offer the searched place name as the society, if nothing is filled in yet.
    if (p.label) {
      const first = p.label.split(',')[0]?.trim().slice(0, 120) ?? '';
      if (first) setAddr((a) => (a.society.trim() || a.area.trim() ? a : { ...a, society: first }));
    }
  };

  const inaccurate = pin?.accuracyM !== undefined && pin.accuracyM > ACCURACY_OK_M;
  // for moving between screens a check still running is not a "no"; Pay itself waits for a yes
  const areaOpen = area.kind === 'yes' || area.kind === 'checking' || area.kind === 'idle';
  const whereDone = !!pin && areaOpen && !inaccurate && Object.keys(addressProblems(addr)).length === 0;
  const planDone = !!q;
  const reachable = (s: Step) => s === 'where' || (s === 'plan' ? whereDone : whereDone && planDone);
  reachRef.current = reachable;
  const backToPay = reachedPay && planDone;

  if (renewal.kind !== 'none' && renewal.kind !== 'ready') {
    return (
      <main className="sb">
        <RenewalGate renewal={renewal} onSignedIn={() => router.refresh()} />
      </main>
    );
  }

  const plan: PlanBody | null =
    milk && qty && term
      ? {
          purpose: ready ? 'renewal' : 'new',
          kind: milk,
          quantityId: qty,
          tenureId: term,
          ...(ready ? { renewsSubscriptionId: ready.subscriptionId } : {}),
          ...(!ready && start.mode === 'later' && start.date ? { startDate: start.date } : {}),
        }
      : null;

  return (
    <main className={`sb${finished ? ' is-finished' : ''}`}>
      <div className="sb-grid">
        <div className="sb-flow">
          {!finished ? <Stepper step={step} reachable={reachable} onOpen={(s) => go(s)} /> : null}

          {ready && !finished ? (
            <div className="sb-notice is-ok">
              <span className="sb-dot" aria-hidden="true" />
              <span>
                Renewing your plan that ends on <b>{dateLabel(ready.endDate)}</b>. Your address and pin are filled
                in — change anything you need.
              </span>
            </div>
          ) : null}

          {step === 'where' && (
            <WhereStep
              pin={pin}
              setPin={setPin}
              area={area}
              addr={addr}
              setAddr={(a) => {
                clearError('where');
                setAddr(a);
              }}
              error={errors.where}
              rules={rules}
              onRecheck={recheck}
              nextLabel={backToPay ? 'Continue to pay' : 'Next: choose your milk'}
              onNext={() => go(backToPay ? 'pay' : 'plan')}
            />
          )}

          {step === 'plan' && (
            <PlanStep
              milk={milk}
              setMilk={(k) => {
                clearError('plan');
                setMilk(k);
              }}
              qty={qty}
              setQty={(id) => {
                clearError('plan');
                setQty(id);
              }}
              term={term}
              setTerm={(id) => {
                clearError('plan');
                setTerm(id);
              }}
              q={q}
              plan={plan}
              renewal={ready}
              start={start}
              setStart={(c) => {
                clearError('plan');
                setStart(c);
              }}
              error={errors.plan}
              rules={rules}
              onNext={() => go('pay')}
            />
          )}

          {step === 'pay' && plan && pin && q ? (
            <PayStep
              plan={plan}
              q={q}
              pin={pin}
              area={area}
              addr={addr}
              rules={rules}
              error={errors.pay}
              clearError={() => clearError('pay')}
              onFail={routeFail}
              onEdit={(s) => go(s)}
              payKey={payKey}
              setPayKey={setPayKey}
              onFinished={(clear) => {
                setFinished(true);
                if (clear) clearDraft();
              }}
            />
          ) : step === 'pay' ? (
            <MissingPrior label={!pin ? 'your delivery address' : 'your plan'} onFix={() => go(!pin ? 'where' : 'plan')} />
          ) : null}
        </div>

        {!finished ? (
          <aside className="sb-rail" aria-label="Your plan so far">
            <SummaryCard milk={milk} qty={qty} term={term} q={q} area={area} address={composeAddress(addr)} />
          </aside>
        ) : null}
      </div>
    </main>
  );
}

/* --------------------------------------------------------------- shared UI -- */

function Stepper({ step, reachable, onOpen }: { step: Step; reachable: (s: Step) => boolean; onOpen: (s: Step) => void }) {
  const idx = FLOW_STEPS.indexOf(step);
  return (
    <nav className="sb-stepper" aria-label="Sign-up steps">
      <ol>
        {FLOW_STEPS.map((s, n) => {
          const done = n < idx;
          const inner = (
            <>
              <span className="sb-stepno" aria-hidden="true">
                {done ? '✓' : n + 1}
              </span>
              <span className="sb-steplabel">{STEP_LABELS[s]}</span>
              {done ? <span className="sb-visually-hidden"> (done)</span> : null}
            </>
          );
          return (
            <li
              key={s}
              className={n === idx ? 'is-current' : done ? 'is-done' : undefined}
              aria-current={n === idx ? 'step' : undefined}
            >
              {n !== idx && reachable(s) ? (
                <button type="button" className="sb-stepitem" onClick={() => onOpen(s)}>
                  {inner}
                </button>
              ) : (
                <span className="sb-stepitem">{inner}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepError({ fail }: { fail: ApiFail | undefined }) {
  if (!fail) return null;
  return (
    <div className="sb-notice is-err" role="alert">
      <span className="sb-dot" aria-hidden="true" />
      <div>
        <b>{fail.error}</b>
        {fail.issues.length ? (
          <ul className="sb-issues">
            {fail.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        ) : null}
        {fail.missing?.length ? (
          IS_DEV ? (
            <p className="sb-issues">
              Missing configuration: {fail.missing.map((m) => <code key={m}>{m} </code>)}
            </p>
          ) : (
            <p className="sb-issues">
              Online sign-up is paused — call <a href={PHONE_HREF}>{PHONE}</a>.
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}

function MissingPrior({ label, onFix }: { label: string; onFix: () => void }) {
  return (
    <section className="sb-panel">
      <h1>One thing first</h1>
      <p className="sb-lead">Please choose {label} first.</p>
      <button type="button" className="sb-btn" onClick={onFix}>
        Go back
      </button>
    </section>
  );
}

/** Env-var names are for developers only; the public never sees them (§9). */
const IS_DEV = process.env.NODE_ENV !== 'production';

function DevMissing({ title, missing }: { title: string; missing: string[] }) {
  if (!IS_DEV) {
    return (
      <div className="sb-notice is-err" role="alert">
        <span className="sb-dot" aria-hidden="true" />
        <span>
          Online sign-up is paused — call <a href={PHONE_HREF}>{PHONE}</a> and we will set up your delivery.
        </span>
      </div>
    );
  }
  return (
    <div className="sb-dev" role="status">
      <strong>{title}</strong>
      <ul>
        {missing.length ? (
          missing.map((m) => (
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
}

const PHONE = CONTACT.phones[0] ?? '';
const PHONE_HREF = `tel:${PHONE.replace(/\s/g, '')}`;
/** Shown before anything is asked: each milk's standard rate, straight from the price list. */
const PRICE_LINE = `${PRODUCTS.map((p) => `${p.label} ${formatINR(p.baseRatePaise)} a litre`).join(', ')}, less on longer plans. One payment for the whole plan, no auto-renewal.`;
/** The farm's WhatsApp number, once confirmed (docs/CLIENT-QUESTIONS.md). */
const WHATSAPP = CONTACT.whatsapp;

/** Ways to reach the farm when we cannot sign someone up online. Nothing is charged. */
function ContactActions({ pin, subject }: { pin: PickedLocation | null; subject: string }) {
  const where = pin ? `https://www.google.com/maps?q=${pin.lat.toFixed(5)},${pin.lng.toFixed(5)}` : '';
  const text = `Hello Maavuli, I would like milk delivered here: ${where}`;
  return (
    <div className="sb-contact">
      {WHATSAPP ? (
        <a
          className="sb-ghost"
          href={`https://wa.me/${WHATSAPP.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Message us on WhatsApp
        </a>
      ) : null}
      <a className="sb-ghost" href={PHONE_HREF}>
        Call {PHONE}
      </a>
      <a
        className="sb-ghost"
        href={`mailto:${CONTACT.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`}
      >
        Email us your location
      </a>
    </div>
  );
}

function EditButton({ what, onClick }: { what: string; onClick: () => void }) {
  return (
    <button type="button" className="sb-linkbtn" onClick={onClick}>
      Edit<span className="sb-visually-hidden"> {what}</span>
    </button>
  );
}

/* ------------------------------------------------------------ 1. where ---- */

function WhereStep({
  pin,
  setPin,
  area,
  addr,
  setAddr,
  error,
  rules,
  onRecheck,
  nextLabel,
  onNext,
}: {
  pin: PickedLocation | null;
  setPin: (p: PickedLocation) => void;
  area: Area;
  addr: AddressForm;
  setAddr: (a: AddressForm) => void;
  error: ApiFail | undefined;
  rules: DayRuleLabels;
  onRecheck: () => void;
  nextLabel: string;
  onNext: () => void;
}) {
  const inaccurate = pin?.accuracyM !== undefined && pin.accuracyM > ACCURACY_OK_M;
  const pinOk = !!pin && area.kind === 'yes' && !inaccurate;
  // Once a pin has been confirmed, nudging it re-runs the check: keep the door form up
  // (and what is typed in it) while that runs, instead of flashing it away.
  const confirmedOnce = useRef(false);
  if (!pin || inaccurate || (area.kind !== 'yes' && area.kind !== 'checking')) confirmedOnce.current = false;
  else if (area.kind === 'yes') confirmedOnce.current = true;
  const showDoor = pinOk || (!!pin && !inaccurate && area.kind === 'checking' && confirmedOnce.current);
  // Outside the area (or orders not open online / sign-up paused) the contact buttons
  // are the next step: a greyed-out Continue beside them only invites useless taps.
  const deadEnd = !!pin && !inaccurate && (area.kind === 'no' || area.kind === 'unknown' || area.kind === 'unconfigured');
  const hint = !pin
    ? 'Mark your building on the map to continue.'
    : inaccurate
      ? 'Drag the marker (or use the arrows) onto your building to continue.'
      : area.kind === 'down'
        ? 'Check again to continue.'
        : '';

  return (
    <section className="sb-panel" aria-labelledby="sb-where-h">
      <h1 id="sb-where-h">Where should we deliver?</h1>
      <p className="sb-lead">
        Mark your building on the map. Our delivery person comes to this exact spot every morning, so we first check
        that we deliver there.
      </p>
      <p className="sb-hint sb-priceline">{PRICE_LINE}</p>
      <StepError fail={error} />

      <LocationPicker value={pin} onChange={setPin} />

      <div className="sb-areastate" aria-live="polite">
        {area.kind === 'checking' ? (
          <p className="sb-secondary">
            <span className="sb-spinner" aria-hidden="true" /> Checking whether we deliver here…
          </p>
        ) : area.kind === 'yes' ? (
          <div className="sb-notice is-ok">
            <span className="sb-dot" aria-hidden="true" />
            {/* zone names are internal (the live one reads "TEST ZONE - not a confirmed service area"): never shown */}
            <span>
              <b>We deliver here</b>. Milk arrives between {rules.windowStart} and {rules.windowEnd} each morning.
            </span>
          </div>
        ) : area.kind === 'no' ? (
          <div className="sb-notice">
            <span className="sb-dot" aria-hidden="true" />
            <div>
              <b>We don’t deliver to this spot yet.</b>
              <p>
                If the marker is in the wrong place, drag it onto your building. If it is right, tell us: we are adding
                areas. Nothing is charged.
              </p>
              <ContactActions pin={pin} subject="Delivery area request — Maavuli" />
            </div>
          </div>
        ) : area.kind === 'unknown' ? (
          <div className="sb-notice is-warn">
            <span className="sb-dot" aria-hidden="true" />
            <div>
              <b>We are not taking orders online just yet.</b> Tell us where you are and we will help you set up
              delivery. Nothing is charged.
              <ContactActions pin={pin} subject="Subscription interest — Maavuli" />
            </div>
          </div>
        ) : area.kind === 'down' ? (
          <div className="sb-notice is-err">
            <span className="sb-dot" aria-hidden="true" />
            <span>
              We could not check this spot just now. That is a problem on our side, not a “no”.{' '}
              <button type="button" className="sb-linkbtn" onClick={onRecheck}>
                Check again
              </button>
            </span>
          </div>
        ) : area.kind === 'unconfigured' ? (
          <DevMissing title="Developer notice — serviceability is not configured (503). Missing:" missing={area.missing} />
        ) : null}
      </div>

      {showDoor ? (
        <DoorForm addr={addr} setAddr={setAddr} nextLabel={nextLabel} canSubmit={pinOk} onNext={onNext} />
      ) : deadEnd ? null : (
        <>
          <div className="sb-nav">
            <button type="button" className="sb-btn" disabled>
              {nextLabel}
            </button>
          </div>
          {hint ? <p className="sb-hint">{hint}</p> : null}
          <p className="sb-hint">
            Finding the map hard? Call <a href={PHONE_HREF}>{PHONE}</a> and we will set up your delivery.
          </p>
        </>
      )}
    </section>
  );
}

function DoorForm({
  addr,
  setAddr,
  nextLabel,
  canSubmit,
  onNext,
}: {
  addr: AddressForm;
  setAddr: (a: AddressForm) => void;
  nextLabel: string;
  /** false while a moved pin is being re-checked */
  canSubmit: boolean;
  onNext: () => void;
}) {
  const [touched, setTouched] = useState(false);
  const [more, setMore] = useState(() => !!(addr.building || addr.area || addr.pincode || addr.landmark || addr.instructions));
  const problems = addressProblems(addr);
  const valid = Object.keys(problems).length === 0;
  const set = (k: keyof AddressForm) => (e: { target: { value: string } }) => setAddr({ ...addr, [k]: e.target.value });
  const show = (k: keyof AddressForm | 'address') => (touched ? problems[k] : undefined);

  const field = (
    k: keyof AddressForm,
    label: string,
    opts: { required?: boolean; placeholder?: string; auto?: string; max?: number; inputMode?: 'numeric' } = {},
  ) => {
    const id = `sb-addr-${k}`;
    const msg = show(k);
    return (
      <div className="sb-field">
        <label htmlFor={id}>
          {label} {opts.required ? <span aria-hidden="true">*</span> : <i>(optional)</i>}
        </label>
        <input
          id={id}
          className="sb-input"
          value={addr[k]}
          onChange={set(k)}
          autoComplete={opts.auto ?? 'off'}
          maxLength={opts.max ?? 120}
          placeholder={opts.placeholder}
          inputMode={opts.inputMode}
          required={opts.required}
          aria-invalid={msg ? true : undefined}
          aria-describedby={msg ? `${id}-err` : undefined}
        />
        {msg ? (
          <em id={`${id}-err`} className="sb-fieldnote">
            {msg}
          </em>
        ) : null}
      </div>
    );
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setTouched(true);
    if (valid) {
      onNext();
      return;
    }
    // Take the customer to the first field that needs them.
    const first = (['name', 'house', 'society', 'pincode'] as const).find((k) => problems[k]) ?? 'society';
    if (first === 'pincode') setMore(true);
    window.setTimeout(() => document.getElementById(`sb-addr-${first}`)?.focus(), 0);
  };

  const line = composeAddress(addr);
  return (
    <form className="sb-door" noValidate onSubmit={submit} aria-labelledby="sb-door-h">
      <h2 id="sb-door-h" className="sb-subhead">
        Your door
      </h2>
      <p className="sb-hint">The map gets us to your building. These get the milk to your door.</p>
      <div className="sb-fields">
        {field('name', 'Name for the delivery', { required: true, auto: 'name', max: 100, placeholder: 'Who should we ask for at the door?' })}
        <div className="sb-row2">
          {field('house', 'Flat / house', { required: true, max: 100, placeholder: 'e.g. 304' })}
          {field('floor', 'Floor', { max: 40, placeholder: 'e.g. 3' })}
        </div>
        {field('society', 'Society, building or street', {
          required: true,
          max: 120,
          auto: 'address-line1',
          placeholder: 'e.g. Aparna Towers',
        })}
        {more ? (
          <>
            {field('building', 'Tower / block', { max: 120, placeholder: 'e.g. Block B' })}
            {field('area', 'Area / locality', { max: 120, auto: 'address-level3', placeholder: 'e.g. Safilguda' })}
            {field('pincode', 'Pincode', { max: 6, auto: 'postal-code', inputMode: 'numeric', placeholder: '6 digits' })}
            {field('landmark', 'Landmark', { max: 300, placeholder: 'Opposite the water tank, blue gate…' })}
            <div className="sb-field">
              <label htmlFor="sb-addr-instructions">
                Note for the delivery person <i>(optional)</i>
              </label>
              <textarea
                id="sb-addr-instructions"
                className="sb-input"
                value={addr.instructions}
                onChange={set('instructions')}
                rows={2}
                maxLength={500}
                placeholder="Hang the bag on the handle, ring twice, leave with security…"
              />
            </div>
          </>
        ) : (
          <button type="button" className="sb-linkbtn sb-more" onClick={() => setMore(true)}>
            + Add a landmark, tower, pincode or a note for the delivery person
          </button>
        )}
      </div>

      {line ? (
        <p className="sb-hint sb-reads">
          The delivery person will read: <b>{line}</b>
        </p>
      ) : null}
      {show('address') ? <p className="sb-fieldnote">{show('address')}</p> : null}
      {touched && !valid ? (
        <p className="sb-fieldnote" role="alert">
          Please check the fields marked with “!” above.
        </p>
      ) : null}

      <div className="sb-nav">
        <button type="submit" className="sb-btn" disabled={!canSubmit}>
          {nextLabel}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------- 2. plan ---- */

function PlanStep({
  milk,
  setMilk,
  qty,
  setQty,
  term,
  setTerm,
  q,
  plan,
  renewal,
  start,
  setStart,
  error,
  rules,
  onNext,
}: {
  milk: MilkKind | null;
  setMilk: (k: MilkKind) => void;
  qty: string | null;
  setQty: (id: string) => void;
  term: string | null;
  setTerm: (id: string) => void;
  q: ReturnType<typeof quote> | null;
  plan: PlanBody | null;
  renewal: Ready | null;
  start: StartChoice;
  setStart: (c: StartChoice) => void;
  error: ApiFail | undefined;
  rules: DayRuleLabels;
  onNext: () => void;
}) {
  // Ask for the EARLIEST date (no startDate), so the answer is the first open date.
  const earliest = plan
    ? {
        purpose: plan.purpose,
        kind: plan.kind,
        quantityId: plan.quantityId,
        tenureId: plan.tenureId,
        ...(plan.renewsSubscriptionId ? { renewsSubscriptionId: plan.renewsSubscriptionId } : {}),
        useCredit: false,
      }
    : null;
  const [pv, retry] = usePreview(earliest);
  const known = pv.kind === 'ok' ? pv.data : pv.kind === 'loading' ? pv.last : undefined;
  const latest = addDaysYMD(istToday(), 30);

  let laterProblem: string | null = null;
  if (!renewal && known && start.mode === 'later') {
    if (!start.date) laterProblem = 'Pick a date.';
    else if (start.date < known.firstOpenDate) laterProblem = `The earliest we can start is ${dateLabel(known.firstOpenDate)}.`;
    else if (start.date > latest) laterProblem = `The first delivery can be at most 30 days away (${dateLabel(latest)}).`;
  }
  const missing = [!milk && 'the milk', !qty && 'how much', !term && 'how long'].filter((x): x is string => !!x);
  const canGo = !!q && !laterProblem;

  return (
    <section className="sb-panel" aria-labelledby="sb-plan-h">
      <h1 id="sb-plan-h">Your milk</h1>
      <StepError fail={error} />

      <fieldset className="sb-group">
        <legend>Milk</legend>
        <div className="sb-milks">
          {PRODUCTS.map((p) => {
            const on = milk === p.kind;
            return (
              <label key={p.kind} className={`sb-milk${on ? ' is-on' : ''}`}>
                <input
                  type="radio"
                  name="sb-milk"
                  className="sb-visually-hidden"
                  checked={on}
                  onChange={() => setMilk(p.kind)}
                />
                <Image
                  src={`/hero/bottle-${p.kind}.png`}
                  alt=""
                  width={220}
                  height={220}
                  sizes="(max-width: 30rem) 40vw, 200px"
                  className="sb-milk-img"
                />
                <span className="sb-milk-name">{p.label}</span>
                <span className="sb-milk-rate">{formatINR(p.baseRatePaise)} a litre, less on longer plans</span>
                {/* breedClaim stays null until the client confirms it — asserting it would be inventing a fact. */}
                {p.breedClaim ? <span className="sb-milk-rate">{p.breedClaim}</span> : null}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="sb-group">
        <legend>Each morning</legend>
        <div className="sb-opts">
          {QUANTITIES.map((x) => {
            const on = qty === x.id;
            return (
              <label key={x.id} className={`sb-opt${on ? ' is-on' : ''}`}>
                <input type="radio" name="sb-qty" className="sb-visually-hidden" checked={on} onChange={() => setQty(x.id)} />
                <span>{qtyName(x.id)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="sb-group">
        <legend>For how long</legend>
        <div className="sb-terms">
          {TENURES.map((t) => {
            const on = term === t.id;
            const tq = milk && qty ? quote(milk, qty, t.id) : null;
            const perLitre = milk ? quote(milk, 'one', t.id).perLitrePaise : null;
            const meta = [`${t.days} days`, `pause up to ${pauseDaysFor(t.days)} mornings`, t.discountPct > 0 ? `save ${t.discountPct}%` : null]
              .filter(Boolean)
              .join(' · ');
            return (
              <label key={t.id} className={`sb-term${on ? ' is-on' : ''}`}>
                <input type="radio" name="sb-term" className="sb-visually-hidden" checked={on} onChange={() => setTerm(t.id)} />
                <span className="sb-term-main">
                  <span className="sb-term-name">{t.label}</span>
                  <span className="sb-term-meta">{meta}</span>
                </span>
                {tq || perLitre ? (
                  <span className="sb-term-price">
                    {tq ? <b>{formatINR(tq.finalPaise)}</b> : null}
                    {perLitre ? <span>{formatINR(perLitre)} a litre</span> : null}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
        <p className="sb-hint">
          Paid once for the whole plan. No auto-renewal. Going away? Pause a morning by {rules.cutoff} the day before,
          and it is added to the end of your plan, so you never lose a day you paid for.
        </p>
      </fieldset>

      {q ? (
        <div className="sb-start">
          <p className="sb-legend">First delivery</p>
          {pv.kind === 'error' ? (
            <>
              <StepError fail={pv.fail} />
              <button type="button" className="sb-linkbtn" onClick={retry}>
                Try again
              </button>
            </>
          ) : !known ? (
            <p className="sb-secondary">
              <span className="sb-spinner" aria-hidden="true" /> Finding the earliest delivery date…
            </p>
          ) : renewal ? (
            <p className="sb-start-line">
              <b>{dateLabel(known.startDate, true)}</b>
              {known.startDate === addDaysYMD(renewal.endDate, 1)
                ? `, the day after your current plan ends (${dateLabel(renewal.endDate)})`
                : ', the earliest date still open, because your current plan has already ended'}
              , between {rules.windowStart} and {rules.windowEnd}.
            </p>
          ) : start.mode === 'earliest' ? (
            <>
              <p className="sb-start-line">
                <b>{dateLabel(known.firstOpenDate, true)}</b>, between {rules.windowStart} and {rules.windowEnd}. Orders
                close at {rules.cutoff} the day before, so this is the earliest we can start.
                {error?.code === 'date_locked' ? ' The date you picked closed while you were choosing.' : ''}
              </p>
              <button type="button" className="sb-linkbtn" onClick={() => setStart({ mode: 'later', date: known.firstOpenDate })}>
                Start on a later date
              </button>
            </>
          ) : (
            <div className="sb-field">
              <label htmlFor="sb-start-date">Start on</label>
              <input
                id="sb-start-date"
                className="sb-input"
                type="date"
                min={known.firstOpenDate}
                max={latest}
                value={start.date}
                onChange={(e) => setStart({ mode: 'later', date: e.target.value })}
                aria-invalid={laterProblem ? true : undefined}
                aria-describedby={laterProblem ? 'sb-start-err' : undefined}
              />
              {start.date && !laterProblem ? <p className="sb-hint">{dateLabel(start.date, true)}</p> : null}
              {laterProblem ? (
                <em id="sb-start-err" className="sb-fieldnote">
                  {laterProblem}
                </em>
              ) : null}
              <button type="button" className="sb-linkbtn" onClick={() => setStart({ mode: 'earliest', date: '' })}>
                Start as early as possible ({dateLabel(known.firstOpenDate)})
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div className="sb-dock">
        <div className="sb-dock-sum" aria-live="polite">
          {q ? (
            <>
              <b className="sb-dock-amt">{formatINR(q.finalPaise)}</b>
              <span className="sb-dock-meta">
                {q.days} days · {formatINR(q.perLitrePaise)} a litre
                {q.savingPaise > 0 ? ` · you save ${formatINR(q.savingPaise)}` : ''}
              </span>
            </>
          ) : (
            <span className="sb-dock-meta">Choose {listJoin(missing)}.</span>
          )}
        </div>
        <button type="button" className="sb-btn" disabled={!canGo} onClick={onNext}>
          Continue
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- 3. pay ---- */

type Auth = { kind: 'loading' } | { kind: 'out' } | { kind: 'in'; mobile: string } | { kind: 'error'; fail: ApiFail };

type Pay =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'ready'; order: CheckoutOrder; note: string | null }
  | { kind: 'verifying' }
  | { kind: 'received'; message: string | null }
  | { kind: 'active'; startDate: string | null; endDate: string | null; fromCredit: boolean };

interface CheckoutResponse {
  orderId: string;
  status: string;
  razorpay: CheckoutOrder | null;
  preview: PreviewJSON;
}

interface VerifyResponse {
  subscriptionId: string | null;
  startDate: string | null;
  endDate: string | null;
}

interface MeResponse {
  authenticated: boolean;
  mobile?: string;
  whatsappOptIn?: boolean;
}

function PayStep({
  plan,
  q,
  pin,
  area,
  addr,
  rules,
  error,
  clearError,
  onFail,
  onEdit,
  payKey,
  setPayKey,
  onFinished,
}: {
  plan: PlanBody;
  q: ReturnType<typeof quote>;
  pin: PickedLocation;
  area: Area;
  addr: AddressForm;
  rules: DayRuleLabels;
  error: ApiFail | undefined;
  clearError: () => void;
  onFail: (f: ApiFail) => void;
  onEdit: (s: Step) => void;
  payKey: PayKey;
  setPayKey: (k: PayKey) => void;
  /** clear = the plan is confirmed, so the saved draft can go */
  onFinished: (clear: boolean) => void;
}) {
  const [auth, setAuth] = useState<Auth>({ kind: 'loading' });
  const [authNonce, setAuthNonce] = useState(0);
  const [useCredit, setUseCredit] = useState(false);
  const [whatsapp, setWhatsapp] = useState(false);
  /** only a box the customer actually changed is sent — see startCheckout */
  const [whatsappTouched, setWhatsappTouched] = useState(false);
  const whatsappTouchedRef = useRef(false);
  const [pay, setPay] = useState<Pay>({ kind: 'idle' });

  // A returning customer who already opted in sees the box ticked (unless they changed it).
  const applyMe = (me: MeResponse) => {
    if (me.authenticated && me.whatsappOptIn === true && !whatsappTouchedRef.current) setWhatsapp(true);
  };

  useEffect(() => {
    let alive = true;
    setAuth({ kind: 'loading' });
    void callApi<MeResponse>('/api/auth/me').then((r) => {
      if (!alive) return;
      if (!r.ok) setAuth({ kind: 'error', fail: r.fail });
      else {
        setAuth(r.data.authenticated && r.data.mobile ? { kind: 'in', mobile: r.data.mobile } : { kind: 'out' });
        applyMe(r.data);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authNonce]);

  // Priced by the server before sign-in (credit 0); priced again once signed in.
  const [pv, retryPreview] = usePreview(
    auth.kind === 'loading' ? null : { ...plan, useCredit },
    auth.kind === 'in' ? auth.mobile : '',
  );
  const known = pv.kind === 'ok' ? pv.data : pv.kind === 'loading' ? pv.last : undefined;

  const addressParts = {
    house: addr.house.trim(),
    ...(addr.floor.trim() ? { floor: addr.floor.trim() } : {}),
    ...(addr.building.trim() ? { building: addr.building.trim() } : {}),
    ...(addr.society.trim() ? { society: addr.society.trim() } : {}),
    ...(addr.area.trim() ? { area: addr.area.trim() } : {}),
    ...(addr.pincode.trim() ? { pincode: addr.pincode.trim() } : {}),
  };
  const details = {
    name: addr.name.trim(),
    address: composeAddress(addr),
    location: { lat: pin.lat, lng: pin.lng },
    ...(addr.landmark.trim() ? { landmark: addr.landmark.trim() } : {}),
    ...(addr.instructions.trim() ? { instructions: addr.instructions.trim() } : {}),
    addressParts,
  };
  const planLabel = `${milkName(plan.kind)} · ${qtyName(plan.quantityId)} each morning · ${termName(plan.tenureId)}`;

  const startCheckout = async () => {
    if (pay.kind === 'creating') return;
    clearError();
    const body = {
      ...plan,
      useCredit,
      details,
      // Consent is sent only when the customer changed the box: untouched leaves the
      // stored preference as it is (lib/orders), so nobody is opted out by omission.
      ...(whatsappTouched ? { whatsappOptIn: whatsapp } : {}),
    };
    // One key per exact request, kept in the tab's draft: a double tap, a retry, or a
    // refresh after paying replays the SAME order instead of creating a second one.
    const sig = JSON.stringify(body);
    const key = payKey && payKey.sig === sig ? payKey.key : newKey();
    if (!payKey || payKey.sig !== sig) setPayKey({ sig, key });
    setPay({ kind: 'creating' });
    const r = await postJson<CheckoutResponse>('/api/checkout', { ...body, idempotencyKey: key });
    if (!r.ok) {
      setPay({ kind: 'idle' });
      if (r.fail.status === 401) {
        setAuth({ kind: 'out' });
        return;
      }
      if (r.fail.status === 409 && r.fail.code === 'conflict') setPayKey(null); // key belonged to another request
      onFail(r.fail);
      return;
    }
    if (r.data.razorpay === null) {
      // Nothing left to pay: fully paid from credit, or an order this key already paid.
      onFinished(true);
      setPay({
        kind: 'active',
        startDate: r.data.preview.startDate,
        endDate: r.data.preview.endDate,
        fromCredit: r.data.preview.payablePaise === 0,
      });
      return;
    }
    setPay({ kind: 'ready', order: r.data.razorpay, note: null });
  };

  const onPaid = async (resp: RazorpayResponse) => {
    setPay({ kind: 'verifying' });
    const r = await postJson<VerifyResponse>('/api/payments/verify', {
      razorpay_order_id: resp.razorpay_order_id,
      razorpay_payment_id: resp.razorpay_payment_id,
      razorpay_signature: resp.razorpay_signature,
    });
    if (r.ok && r.data.subscriptionId) {
      onFinished(true);
      setPay({ kind: 'active', startDate: r.data.startDate, endDate: r.data.endDate, fromCredit: false });
      return;
    }
    // Money moved; our confirmation did not land. Never call this a failure — the
    // Razorpay webhook is the backstop that activates the plan. The draft (with the
    // same idempotency key) is KEPT, so paying "again" after a refresh replays this order.
    onFinished(false);
    setPay({ kind: 'received', message: r.ok ? null : r.fail.error });
  };

  if (pay.kind === 'active') return <Success {...pay} rules={rules} />;
  if (pay.kind === 'received') return <PaymentReceived />;

  const total = known ? known.amountPaise : q.finalPaise;
  const saving = known ? known.savingPaise : q.savingPaise;

  return (
    <section className="sb-panel" aria-labelledby="sb-pay-h">
      <h1 id="sb-pay-h">Check and pay</h1>
      <StepError fail={error} />

      <div className="sb-receipt">
        <dl>
          <div>
            <dt>Milk</dt>
            <dd>
              {milkName(plan.kind)} · {qtyName(plan.quantityId)} each morning
            </dd>
            <dd className="sb-edit">
              <EditButton what="milk and amount" onClick={() => onEdit('plan')} />
            </dd>
          </div>
          <div>
            <dt>For</dt>
            <dd>
              {termName(plan.tenureId)} ({q.days} days) · pause up to {pauseDaysFor(q.days)} mornings
            </dd>
            <dd className="sb-edit" />
          </div>
          <div>
            <dt>When</dt>
            <dd>
              {known ? (
                <>
                  {dateLabel(known.startDate)} → {dateLabel(known.endDate, true)}
                </>
              ) : pv.kind === 'error' ? (
                'Dates not confirmed yet'
              ) : (
                'Working out the dates…'
              )}{' '}
              · {rules.windowStart}–{rules.windowEnd}
            </dd>
            <dd className="sb-edit">
              <EditButton what="start date" onClick={() => onEdit('plan')} />
            </dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>
              {details.name}, {details.address}
              {details.landmark ? ` (${details.landmark})` : ''}
            </dd>
            <dd className="sb-edit">
              <EditButton what="address" onClick={() => onEdit('where')} />
            </dd>
          </div>
        </dl>
        <div className="sb-receipt-total">
          <span>{saving > 0 ? `Total · you save ${formatINR(saving)}` : 'Total'}</span>
          <b>{formatINR(total)}</b>
        </div>
        {known && known.creditAppliedPaise > 0 ? (
          <>
            <div className="sb-receipt-line">
              <span>Paid from your credit</span>
              <b>− {formatINR(known.creditAppliedPaise)}</b>
            </div>
            <div className="sb-receipt-total">
              <span>To pay now</span>
              <b>{formatINR(known.payablePaise)}</b>
            </div>
          </>
        ) : null}
      </div>
      <p className="sb-hint">
        One payment for the whole plan. No auto-renewal. You can pause a morning until {rules.cutoff} the day before.
      </p>

      {pv.kind === 'error' ? (
        <>
          <StepError fail={pv.fail} />
          <button
            type="button"
            className="sb-btn"
            onClick={() => {
              if (stepForFail(pv.fail) !== 'pay') onFail(pv.fail);
              else retryPreview();
            }}
          >
            {FIX_LABEL[stepForFail(pv.fail)]}
          </button>
        </>
      ) : null}

      {area.kind === 'idle' || area.kind === 'checking' ? (
        <p className="sb-secondary">
          <span className="sb-spinner" aria-hidden="true" /> Checking your delivery area…
        </p>
      ) : area.kind !== 'yes' ? (
        <div className="sb-notice is-err" role="alert">
          <span className="sb-dot" aria-hidden="true" />
          <span>
            We cannot confirm delivery to the spot you marked.{' '}
            <button type="button" className="sb-linkbtn" onClick={() => onEdit('where')}>
              Go back to the map
            </button>
          </span>
        </div>
      ) : auth.kind === 'loading' ? (
        <p className="sb-secondary">
          <span className="sb-spinner" aria-hidden="true" /> Checking your sign-in…
        </p>
      ) : auth.kind === 'error' ? (
        <>
          {auth.fail.missing ? (
            <DevMissing title="Developer notice — the account service is not configured (503). Missing:" missing={auth.fail.missing} />
          ) : (
            <StepError fail={auth.fail} />
          )}
          <button type="button" className="sb-btn" onClick={() => setAuthNonce((n) => n + 1)}>
            Try again
          </button>
          <p className="sb-secondary">
            Or call <a href={PHONE_HREF}>{PHONE}</a> to arrange delivery.
          </p>
        </>
      ) : auth.kind === 'out' ? (
        <div className="sb-signin">
          <h2 className="sb-subhead">Confirm your mobile number</h2>
          <OtpForm
            intro={`We send a 6-digit code to your mobile on WhatsApp. There is no password. No WhatsApp? Call ${PHONE}.`}
            onSignedIn={(mobile) => {
              setAuth({ kind: 'in', mobile });
              void callApi<MeResponse>('/api/auth/me').then((r) => {
                if (r.ok) applyMe(r.data);
              });
            }}
          />
        </div>
      ) : (
        <div className="sb-pay">
          <p className="sb-secondary">
            Signed in as {formatMobile(auth.mobile)}.{' '}
            <button
              type="button"
              className="sb-linkbtn"
              disabled={pay.kind !== 'idle'}
              onClick={async () => {
                await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
                setPayKey(null);
                setAuth({ kind: 'out' });
              }}
            >
              Use a different number
            </button>
          </p>

          {known && known.creditAvailablePaise > 0 ? (
            <label className="sb-check-row">
              <input
                type="checkbox"
                checked={useCredit}
                disabled={pay.kind !== 'idle'}
                onChange={(e) => setUseCredit(e.target.checked)}
              />
              <span>Use my Maavuli credit ({formatINR(known.creditAvailablePaise)} available)</span>
            </label>
          ) : null}

          <label className="sb-check-row">
            <input
              type="checkbox"
              checked={whatsapp}
              disabled={pay.kind !== 'idle'}
              onChange={(e) => {
                whatsappTouchedRef.current = true;
                setWhatsappTouched(true);
                setWhatsapp(e.target.checked);
              }}
            />
            <span>
              Send me delivery updates on WhatsApp. No marketing.
              <small className="sb-check-note">
                Order confirmation, the day before the first delivery, and if a delivery is missed or a refund is made.
                You can turn this off any time in your account.
              </small>
            </span>
          </label>

          {pay.kind === 'ready' ? (
            <>
              <RazorpayCheckout
                order={pay.order}
                mobile={auth.mobile}
                planLabel={planLabel}
                label={`Pay ${formatINR(pay.order.amountPaise)}`}
                onOpen={() => setPay((p) => (p.kind === 'ready' ? { ...p, note: null } : p))}
                onDismiss={() =>
                  setPay((p) =>
                    p.kind === 'ready'
                      ? {
                          ...p,
                          note: `The payment window closed before we received a payment. If money has left your account, do not pay again: your plan will appear in My Deliveries within a few minutes, or call ${PHONE}. Otherwise, tap Pay ${formatINR(p.order.amountPaise)} to try again.`,
                        }
                      : p,
                  )
                }
                onPaid={(r) => void onPaid(r)}
                onError={(message) => setPay((p) => (p.kind === 'ready' ? { ...p, note: message } : p))}
              />
              {pay.note ? (
                <div className="sb-notice is-err" role="alert">
                  <span className="sb-dot" aria-hidden="true" />
                  <span>{pay.note}</span>
                </div>
              ) : null}
            </>
          ) : pay.kind === 'verifying' ? (
            <p className="sb-secondary" role="status">
              <span className="sb-spinner" aria-hidden="true" /> Payment received — confirming it…
            </p>
          ) : pv.kind === 'ok' ? (
            <button
              type="button"
              className={`sb-btn sb-paybtn${pay.kind === 'creating' ? ' is-busy' : ''}`}
              onClick={() => void startCheckout()}
              disabled={pay.kind === 'creating'}
            >
              {pay.kind === 'creating' ? (
                <>
                  <span className="sb-spinner" aria-hidden="true" /> Starting…
                </>
              ) : pv.data.payablePaise === 0 ? (
                'Confirm — paid from credit'
              ) : (
                `Pay ${formatINR(pv.data.payablePaise)}`
              )}
            </button>
          ) : pv.kind === 'loading' ? (
            <p className="sb-secondary">
              <span className="sb-spinner" aria-hidden="true" /> Working out your final amount…
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function Success({
  startDate,
  endDate,
  fromCredit,
  rules,
}: {
  startDate: string | null;
  endDate: string | null;
  fromCredit: boolean;
  rules: DayRuleLabels;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  return (
    <section className="sb-panel" aria-labelledby="sb-done-h">
      <div className="sb-success" role="status">
        <span className="sb-check" aria-hidden="true">
          ✓
        </span>
        <h1 id="sb-done-h" ref={ref} tabIndex={-1}>
          {fromCredit ? 'Done — paid from your credit.' : 'Your plan is confirmed.'}
        </h1>
        {startDate ? (
          <p className="sb-lead">
            Your first milk comes on <b>{dateLabel(startDate, true)}</b>, between {rules.windowStart} and{' '}
            {rules.windowEnd}.{endDate ? <> The plan runs to <b>{dateLabel(endDate, true)}</b>.</> : null}
          </p>
        ) : null}
        <p className="sb-lead">
          If you turned on WhatsApp updates, we will message you the day before your first milk. Pause a morning or see
          your schedule in My Deliveries.
        </p>
        <Link className="sb-btn" href="/account">
          Go to my deliveries
        </Link>
      </div>
    </section>
  );
}

function PaymentReceived() {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  return (
    <section className="sb-panel" aria-labelledby="sb-received-h">
      <div className="sb-success" role="status">
        <span className="sb-check" aria-hidden="true">
          ✓
        </span>
        <h1 id="sb-received-h" ref={ref} tabIndex={-1}>
          Payment received.
        </h1>
        <p className="sb-lead">
          Your payment went through. We are still confirming it, so your plan may take a few minutes to appear in{' '}
          <Link href="/account">My Deliveries</Link>. Please <b>do not pay again</b>. If it has not appeared within an
          hour, call <a href={PHONE_HREF}>{PHONE}</a>.
        </p>
        <Link className="sb-btn" href="/account">
          Go to my deliveries
        </Link>
      </div>
    </section>
  );
}

/* --------------------------------------------------------- renewal gate ---- */

function RenewalGate({
  renewal,
  onSignedIn,
}: {
  renewal: Exclude<RenewalProp, { kind: 'none' } | { kind: 'ready' }>;
  onSignedIn: () => void;
}) {
  return (
    <section className="sb-panel">
      <p className="eyebrow">Renew your plan</p>
      {renewal.kind === 'signed_out' ? (
        <>
          <h1>Sign in to renew.</h1>
          <OtpForm intro="Sign in with the mobile your plan is on." onSignedIn={onSignedIn} />
        </>
      ) : renewal.kind === 'not_found' ? (
        <>
          <h1>We could not find that plan.</h1>
          <p className="sb-lead">
            It is not on the account you are signed in with. Check <Link href="/account">My Deliveries</Link>, or{' '}
            <Link href="/subscribe">start a new plan</Link>.
          </p>
        </>
      ) : renewal.kind === 'not_renewable' ? (
        <>
          <h1>This plan cannot be renewed.</h1>
          <p className="sb-lead">{renewal.reason}</p>
          <p className="sb-secondary">
            <Link href="/account">My Deliveries</Link> · <Link href="/subscribe">Start a new plan</Link>
          </p>
        </>
      ) : (
        <>
          <h1>We could not load your plan.</h1>
          <p className="sb-lead">That is a problem on our side. Please reload in a moment.</p>
          {renewal.missing.length ? <DevMissing title="Developer notice — not configured. Missing:" missing={renewal.missing} /> : null}
        </>
      )}
    </section>
  );
}

/* --------------------------------------------------------- summary rail ---- */

function SummaryCard({
  milk,
  qty,
  term,
  q,
  area,
  address,
}: {
  milk: MilkKind | null;
  qty: string | null;
  term: string | null;
  q: ReturnType<typeof quote> | null;
  area: Area;
  address: string;
}) {
  const areaLine =
    area.kind === 'yes'
      ? 'We deliver here'
      : area.kind === 'no'
        ? 'Not in our area yet'
        : area.kind === 'unknown'
          ? 'Area not published yet'
          : area.kind === 'checking'
            ? 'Checking…'
            : area.kind === 'down' || area.kind === 'unconfigured'
              ? 'Could not check'
              : null;

  return (
    <div className="sb-card">
      <p className="sb-card-eyebrow">Your plan</p>
      <div className="sb-price">
        {q ? (
          <>
            <span className="sb-amount">{formatINR(q.finalPaise)}</span>
            <span className="sb-per">
              {formatINR(q.perLitrePaise)} a litre · {q.days} days, paid once
            </span>
          </>
        ) : (
          <>
            <span className="sb-amount is-pending">—</span>
            <span className="sb-per">Choose the milk, how much and how long</span>
          </>
        )}
      </div>
      <ul className="sb-lines">
        <li className={areaLine ? undefined : 'is-empty'}>
          <span>Where</span>
          <b>{areaLine ?? 'no pin yet'}</b>
        </li>
        <li className={address ? undefined : 'is-empty'}>
          <span>Door</span>
          <b>{address || 'not entered'}</b>
        </li>
        <li className={milk ? undefined : 'is-empty'}>
          <span>Milk</span>
          <b>{milk ? milkName(milk) : 'not chosen'}</b>
        </li>
        <li className={qty ? undefined : 'is-empty'}>
          <span>Each morning</span>
          <b>{qty ? qtyName(qty) : 'not chosen'}</b>
        </li>
        <li className={term ? undefined : 'is-empty'}>
          <span>For</span>
          <b>{term ? `${termName(term)} · pause up to ${pauseDaysFor(q?.days ?? TENURES.find((t) => t.id === term)?.days ?? 30)} mornings` : 'not chosen'}</b>
        </li>
        {q && q.savingPaise > 0 ? (
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
      </ul>
      <p className="sb-rail-note">One payment for the whole plan. No auto-renewal.</p>
    </div>
  );
}

/* ------------------------------------------------------------- preview ---- */

/** `last` keeps the previous answer on screen while a new one loads, so nothing flickers. */
type Load<T> = { kind: 'loading'; last?: T } | { kind: 'error'; fail: ApiFail } | { kind: 'ok'; data: T };

/** POST /api/checkout/preview, re-run whenever the body (or `extraKey`) changes. */
function usePreview(body: (PlanBody & { useCredit: boolean }) | null, extraKey = ''): [Load<PreviewJSON>, () => void] {
  const [state, setState] = useState<Load<PreviewJSON>>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const key = body ? `${JSON.stringify(body)}|${extraKey}` : '';
  useEffect(() => {
    if (!body) return;
    let alive = true;
    setState((s) => ({ kind: 'loading', last: s.kind === 'ok' ? s.data : s.kind === 'loading' ? s.last : undefined }));
    void postJson<{ preview: PreviewJSON }>('/api/checkout/preview', body).then((r) => {
      if (!alive) return;
      setState(r.ok ? { kind: 'ok', data: r.data.preview } : { kind: 'error', fail: r.fail });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  return [state, () => setNonce((n) => n + 1)];
}
