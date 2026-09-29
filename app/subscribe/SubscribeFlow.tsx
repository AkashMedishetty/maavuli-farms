'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PRODUCTS, QUANTITIES, TENURES, quote, formatINR, type MilkKind } from '@/lib/pricing';
import { CONTACT } from '@/lib/content';
import LocationPicker, { type PickedLocation } from '@/components/LocationPicker';
import RazorpayCheckout, { type CheckoutOrder, type RazorpayResponse } from '@/components/RazorpayCheckout';
import OtpForm from './OtpForm';
import {
  EMPTY_ADDRESS,
  addDaysYMD,
  addressProblems,
  callApi,
  composeAddress,
  dateLabel,
  istToday,
  newKey,
  postJson,
  type AddressForm,
} from './lib';
import type { ApiFail, PreviewJSON, RenewalProp } from './types';

/**
 * The subscription funnel, pin first.
 *
 *   1 where   — the exact doorstep on a map, checked against the delivery zones
 *   2 address — name + the parts a rider needs at the door
 *   3–5 plan  — milk → daily amount → term (running price in the rail)
 *   6 start   — earliest open date from the server; later up to 30 days
 *   7 pay     — sign in (OTP) → final numbers + credit → checkout → Razorpay → verify
 *
 * Every rupee figure comes from lib/pricing.quote() (the rail) or the server's
 * /api/checkout/preview (the final numbers). The client never sends an amount.
 *
 * Honest states: serviceability keeps yes / no / not-published / down /
 * unconfigured distinct; every fetch has loading → error → data; an API error is
 * shown next to the step that caused it (a pin outside every zone sends the
 * customer back to step 1; a locked date back to the start-date step).
 */

type Step = 'where' | 'address' | 'milk' | 'qty' | 'term' | 'start' | 'review';
const STEPS: readonly Step[] = ['where', 'address', 'milk', 'qty', 'term', 'start', 'review'];
const STEP_LABELS: Record<Step, string> = {
  where: 'Location',
  address: 'Address',
  milk: 'Milk',
  qty: 'Daily amount',
  term: 'Duration',
  start: 'Start date',
  review: 'Pay',
};

type Area =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'yes'; zone: string | null }
  | { kind: 'no' }
  | { kind: 'unknown'; message: string }
  | { kind: 'down'; message: string }
  | { kind: 'unconfigured'; missing: string[] };

type StepErrors = Partial<Record<Step, ApiFail>>;

interface StartChoice {
  mode: 'earliest' | 'later';
  date: string;
}

/* ------------------------------------------------------------------ helpers -- */

function detailsToForm(r: Extract<RenewalProp, { kind: 'ready' }>): AddressForm {
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

/** Which step an API failure belongs to. */
function stepForFail(f: ApiFail): Step {
  if (f.code === 'date_locked') return 'start';
  // Machine codes from the API first (lib/errors ValidationError.code) — copy edits on
  // the server can never misroute these.
  switch (f.code) {
    case 'outside_zone':
      return 'where';
    case 'details_incomplete':
      return 'address';
    case 'start_invalid':
      return 'start';
    case 'plan_invalid':
      return 'milk';
    case 'not_renewable':
      return 'review';
  }
  // Fallback for errors without a code.
  const text = `${f.error} ${f.issues.join(' ')}`.toLowerCase();
  if (f.status === 400) {
    if (/delivery area|delivery zone|drop a pin|pin on the map/.test(text)) return 'where';
    if (/delivery details|name for the delivery|delivery address|addressparts|house|pincode/.test(text)) return 'address';
    if (/first delivery|startdate/.test(text)) return 'start';
    if (/kind|quantityid|tenureid|plan selection|milk/.test(text)) return 'milk';
  }
  return 'review';
}

function isOutsideZone(f: ApiFail): boolean {
  if (f.code === 'outside_zone') return true;
  return f.status === 400 && /delivery area|delivery zone/i.test(`${f.error} ${f.issues.join(' ')}`);
}

/* =================================================================== flow ==== */

export default function SubscribeFlow({ renewal }: { renewal: RenewalProp }) {
  const router = useRouter();
  const ready = renewal.kind === 'ready' ? renewal : null;

  const [step, setStep] = useState<Step>(ready ? 'start' : 'where');
  const [pin, setPin] = useState<PickedLocation | null>(ready?.details.location ? { ...ready.details.location } : null);
  const [area, setArea] = useState<Area>({ kind: 'idle' });
  const [addr, setAddr] = useState<AddressForm>(ready ? detailsToForm(ready) : EMPTY_ADDRESS);
  const [milk, setMilk] = useState<MilkKind | null>(ready?.milk ?? null);
  const [qty, setQty] = useState<string | null>(ready?.quantityId ?? null);
  const [term, setTerm] = useState<string | null>(ready?.tenureId ?? null);
  const [start, setStart] = useState<StartChoice>({ mode: 'earliest', date: '' });
  const [errors, setErrors] = useState<StepErrors>({});

  // A renewal whose plan ids could not be matched starts at the first missing plan step.
  useEffect(() => {
    if (!ready) return;
    if (!ready.quantityId) setStep('qty');
    else if (!ready.tenureId) setStep('term');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        else setArea({ kind: 'down', message: r.fail.error });
        return;
      }
      if (r.data.serviceable) setArea({ kind: 'yes', zone: r.data.zone ?? null });
      else if (r.data.unknown) setArea({ kind: 'unknown', message: r.data.message ?? 'Our delivery area is not published yet.' });
      else setArea({ kind: 'no' });
    })();
  }, [pin]);

  const recheck = () => setPin((p) => (p ? { ...p } : p));

  /* ---- errors ---- */
  const clearError = (s: Step) => setErrors((e) => (e[s] ? { ...e, [s]: undefined } : e));
  const routeFail = useCallback((f: ApiFail) => {
    const s = stepForFail(f);
    setErrors((e) => ({ ...e, [s]: f }));
    if (s === 'start' && f.code === 'date_locked') setStart({ mode: 'earliest', date: '' });
    if (isOutsideZone(f)) setArea({ kind: 'no' });
    setStep(s);
  }, []);

  const go = (s: Step) => {
    setStep(s);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const idx = STEPS.indexOf(step);
  const pct = Math.round((idx / (STEPS.length - 1)) * 100);

  if (renewal.kind !== 'none' && renewal.kind !== 'ready') {
    return (
      <main className="sb">
        <RenewalGate renewal={renewal} onSignedIn={() => router.refresh()} />
      </main>
    );
  }

  const plan =
    milk && qty && term
      ? {
          purpose: ready ? ('renewal' as const) : ('new' as const),
          kind: milk,
          quantityId: qty,
          tenureId: term,
          ...(ready ? { renewsSubscriptionId: ready.subscriptionId } : {}),
          ...(!ready && start.mode === 'later' && start.date ? { startDate: start.date } : {}),
        }
      : null;

  return (
    <main className="sb">
      <div className="sb-grid">
        <div className="sb-flow">
          <div className="sb-flow-progress">
            <Progress step={step} idx={idx} pct={pct} />
          </div>
          <div className="sb-flow-step">
            {ready ? (
              <div className="sb-notice is-ok" role="status">
                <span className="sb-dot" aria-hidden="true" />
                <span>
                  Renewing your plan that ends on <b>{dateLabel(ready.endDate)}</b>. Your address and pin are
                  filled in — change anything you need.
                </span>
              </div>
            ) : null}

            {step === 'where' && (
              <WhereStep
                pin={pin}
                setPin={(p) => {
                  clearError('where');
                  setPin(p);
                }}
                area={area}
                error={errors.where}
                onRecheck={recheck}
                onNext={() => {
                  // Offer the searched place name as the society, if nothing is filled in yet.
                  if (pin?.label && !addr.society.trim() && !addr.area.trim()) {
                    setAddr((a) => ({ ...a, society: pin.label!.split(',')[0]!.trim().slice(0, 120) }));
                  }
                  clearError('where');
                  go('address');
                }}
              />
            )}

            {step === 'address' && (
              <AddressStep
                value={addr}
                onChange={(a) => {
                  clearError('address');
                  setAddr(a);
                }}
                error={errors.address}
                onNext={() => go(ready && milk && qty && term ? 'start' : 'milk')}
                onBack={() => go('where')}
              />
            )}

            {step === 'milk' && (
              <MilkStep
                selected={milk}
                error={errors.milk}
                onPick={(k) => {
                  clearError('milk');
                  setMilk(k);
                  go('qty');
                }}
                onBack={() => go('address')}
              />
            )}

            {step === 'qty' && milk && (
              <QtyStep milk={milk} selected={qty} onPick={(id) => { setQty(id); go('term'); }} onBack={() => go('milk')} />
            )}
            {step === 'qty' && !milk && <MissingPrior label="the milk" onFix={() => go('milk')} />}

            {step === 'term' && milk && qty && (
              <TermStep milk={milk} qty={qty} selected={term} onPick={(id) => { setTerm(id); go('start'); }} onBack={() => go('qty')} />
            )}
            {step === 'term' && !(milk && qty) && <MissingPrior label="the milk and daily amount" onFix={() => go('milk')} />}

            {step === 'start' && plan && (
              <StartStep
                plan={plan}
                renewal={ready}
                choice={start}
                setChoice={(c) => {
                  clearError('start');
                  setStart(c);
                }}
                error={errors.start}
                onNext={() => {
                  clearError('start');
                  go('review');
                }}
                onBack={() => go(ready ? 'address' : 'term')}
              />
            )}
            {step === 'start' && !plan && <MissingPrior label="your plan" onFix={() => go('milk')} />}

            {step === 'review' && plan && pin && q && (
              <ReviewStep
                plan={plan}
                planLabel={planLabelOf(milk!, qty!, term!)}
                pin={pin}
                area={area}
                addr={addr}
                error={errors.review}
                clearError={() => clearError('review')}
                onFail={routeFail}
                onEdit={go}
              />
            )}
            {step === 'review' && !(plan && pin && q) && (
              <MissingPrior label={!pin ? 'your delivery pin' : 'your plan'} onFix={() => go(!pin ? 'where' : 'milk')} />
            )}

            <p className="sb-foot">
              <Link href="/plans">See every plan and price →</Link>
            </p>
          </div>
        </div>

        <aside className="sb-rail" aria-label="Your plan so far">
          <SummaryCard milk={milk} qty={qty} term={term} q={q} area={area} address={composeAddress(addr)} />
        </aside>
      </div>
    </main>
  );
}

function planLabelOf(milk: MilkKind, qty: string, term: string): string {
  return `${PRODUCTS.find((p) => p.kind === milk)?.label ?? milk} · ${QUANTITIES.find((x) => x.id === qty)?.label ?? qty} · ${
    TENURES.find((t) => t.id === term)?.label ?? term
  }`;
}

/* --------------------------------------------------------------- shared UI -- */

function Progress({ step, idx, pct }: { step: Step; idx: number; pct: number }) {
  return (
    <div className="sb-progress">
      <ol className="sb-steps">
        {STEPS.map((s, n) => (
          <li key={s} className={n === idx ? 'is-current' : n < idx ? 'is-done' : undefined} aria-current={s === step ? 'step' : undefined}>
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
        aria-label={`Step ${idx + 1} of ${STEPS.length}`}
      >
        <div className="sb-bar-fill" style={{ width: `${Math.max(pct, 6)}%` }} />
      </div>
    </div>
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
          <p className="sb-issues">
            Missing configuration: {fail.missing.map((m) => <code key={m}>{m} </code>)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function MissingPrior({ label, onFix }: { label: string; onFix: () => void }) {
  return (
    <section className="sb-panel">
      <p className="sb-lead">Please choose {label} first.</p>
      <button type="button" className="sb-btn" onClick={onFix}>
        Go back
      </button>
    </section>
  );
}

function DevMissing({ title, missing }: { title: string; missing: string[] }) {
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

function contactHref(subject: string, body: string): string {
  return `mailto:${CONTACT.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
const PHONE = CONTACT.phones[0] ?? '';
const PHONE_HREF = `tel:${PHONE.replace(/\s/g, '')}`;

/* ------------------------------------------------------------ 1. where ---- */

function WhereStep({
  pin,
  setPin,
  area,
  error,
  onRecheck,
  onNext,
}: {
  pin: PickedLocation | null;
  setPin: (p: PickedLocation) => void;
  area: Area;
  error: ApiFail | undefined;
  onRecheck: () => void;
  onNext: () => void;
}) {
  const inaccurate = pin?.accuracyM !== undefined && pin.accuracyM > 50;
  const canGo = !!pin && area.kind === 'yes' && !inaccurate;
  const coords = pin ? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}` : '';
  return (
    <section className="sb-panel" aria-labelledby="sb-where-h">
      <p className="eyebrow">Step 1 of {STEPS.length}</p>
      <h1 id="sb-where-h">Where should we deliver?</h1>
      <p className="sb-lead">
        Put the pin on your building. The rider comes to this exact spot every morning, and we check it
        against our delivery zones before you choose anything else.
      </p>
      <StepError fail={error} />

      <LocationPicker value={pin} onChange={setPin} />

      <div className="sb-areastate" aria-live="polite">
        {area.kind === 'checking' ? (
          <p className="sb-secondary">
            <span className="sb-spinner" aria-hidden="true" /> Checking whether we deliver here…
          </p>
        ) : area.kind === 'yes' ? (
          <div className="sb-notice is-ok" role="status">
            <span className="sb-dot" aria-hidden="true" />
            <span>
              <b>Yes — we deliver here</b>
              {area.zone ? ` (${area.zone})` : ''}.
            </span>
          </div>
        ) : area.kind === 'no' ? (
          <div className="sb-notice" role="status">
            <span className="sb-dot" aria-hidden="true" />
            <span>
              We do not deliver to this spot yet. If the pin is in the wrong place, move it. Otherwise{' '}
              <a href={contactHref('Delivery area request — Maavuli', `Please deliver to: ${coords}`)}>tell us where you are</a>{' '}
              or call <a href={PHONE_HREF}>{PHONE}</a> — nothing is charged.
            </span>
          </div>
        ) : area.kind === 'unknown' ? (
          <div className="sb-notice is-warn" role="status">
            <span className="sb-dot" aria-hidden="true" />
            <span>
              {area.message} We cannot take a payment until it is. <a href={contactHref('Subscription interest — Maavuli', `Location: ${coords}`)}>Send us your location</a>{' '}
              or call <a href={PHONE_HREF}>{PHONE}</a>.
            </span>
          </div>
        ) : area.kind === 'down' ? (
          <div className="sb-notice is-err" role="alert">
            <span className="sb-dot" aria-hidden="true" />
            <span>
              We could not check this spot just now — that is a problem on our side, not a “no”. ({area.message}){' '}
              <button type="button" className="sb-linkbtn" onClick={onRecheck}>
                Check again
              </button>
            </span>
          </div>
        ) : area.kind === 'unconfigured' ? (
          <DevMissing title="Developer notice — serviceability is not configured (503). Missing:" missing={area.missing} />
        ) : null}
      </div>

      <div className="sb-nav">
        <button type="button" className="sb-btn" onClick={onNext} disabled={!canGo}>
          Continue
        </button>
      </div>
      {!canGo && pin && inaccurate ? (
        <p className="sb-hint">Drag the pin (or use the arrows) onto your building to continue.</p>
      ) : !pin ? (
        <p className="sb-hint">Place a pin to continue.</p>
      ) : null}
    </section>
  );
}

/* ---------------------------------------------------------- 2. address ---- */

function AddressStep({
  value,
  onChange,
  error,
  onNext,
  onBack,
}: {
  value: AddressForm;
  onChange: (v: AddressForm) => void;
  error: ApiFail | undefined;
  onNext: () => void;
  onBack: () => void;
}) {
  const [touched, setTouched] = useState(false);
  const problems = addressProblems(value);
  const valid = Object.keys(problems).length === 0;
  const set = (k: keyof AddressForm) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
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
          value={value[k]}
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

  const line = composeAddress(value);
  return (
    <section className="sb-panel" aria-labelledby="sb-addr-h">
      <p className="eyebrow">Step 2 of {STEPS.length}</p>
      <h1 id="sb-addr-h">Who and which door?</h1>
      <p className="sb-lead">The pin gets the rider to your building; these get the bottle to your door.</p>
      <StepError fail={error} />

      <form
        className="sb-fields"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (valid) onNext();
        }}
      >
        {field('name', 'Name for the delivery', { required: true, auto: 'name', max: 100, placeholder: 'Who should we ask for?' })}
        {field('house', 'Flat / house number', { required: true, max: 100, placeholder: 'e.g. 304' })}
        {field('floor', 'Floor', { max: 40, placeholder: 'e.g. 3' })}
        {field('building', 'Tower / block', { max: 120, placeholder: 'e.g. Block B' })}
        {field('society', 'Society / apartment / street', { max: 120, auto: 'address-line1', placeholder: 'e.g. Aparna Towers' })}
        {field('area', 'Area / locality', { max: 120, auto: 'address-level3', placeholder: 'e.g. Safilguda' })}
        {field('pincode', 'Pincode', { max: 6, auto: 'postal-code', inputMode: 'numeric', placeholder: '6 digits' })}
        {field('landmark', 'Landmark', { max: 300, placeholder: 'Opposite the water tank, blue gate…' })}
        <div className="sb-field">
          <label htmlFor="sb-addr-instructions">
            Door instructions <i>(optional)</i>
          </label>
          <textarea
            id="sb-addr-instructions"
            value={value.instructions}
            onChange={set('instructions')}
            rows={2}
            maxLength={500}
            placeholder="Hang the bag on the handle, ring twice, leave with security…"
          />
        </div>

        {line ? (
          <p className="sb-hint">
            The rider will read: <b>{line}</b>
          </p>
        ) : null}
        {show('address') ? <p className="sb-fieldnote">{show('address')}</p> : null}

        <div className="sb-nav">
          <button type="submit" className="sb-btn">
            Continue
          </button>
          <button type="button" className="sb-back" onClick={onBack}>
            ← Back to the map
          </button>
        </div>
        {touched && !valid ? <p className="sb-hint" role="alert">Please fix the highlighted fields.</p> : null}
      </form>
    </section>
  );
}

/* ------------------------------------------------------------ 3–5. plan ---- */

function MilkStep({
  selected,
  error,
  onPick,
  onBack,
}: {
  selected: MilkKind | null;
  error: ApiFail | undefined;
  onPick: (k: MilkKind) => void;
  onBack: () => void;
}) {
  return (
    <section className="sb-panel">
      <p className="eyebrow">Step 3 of {STEPS.length}</p>
      <h1>Which milk?</h1>
      <StepError fail={error} />
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
            {/* breedClaim stays null until the client confirms it — asserting it would be inventing a fact. */}
            {p.breedClaim ? (
              <span className="sb-choice-sub">{p.breedClaim}</span>
            ) : (
              <span className="sb-choice-rate">from {formatINR(quote(p.kind, 'one', '1m').perLitrePaise)} / litre</span>
            )}
          </button>
        ))}
      </div>
      <div className="sb-nav">
        <button type="button" className="sb-back" onClick={onBack}>
          ← Back to address
        </button>
      </div>
    </section>
  );
}

function QtyStep({ milk, selected, onPick, onBack }: { milk: MilkKind; selected: string | null; onPick: (id: string) => void; onBack: () => void }) {
  return (
    <section className="sb-panel">
      <p className="eyebrow">Step 4 of {STEPS.length}</p>
      <h1>How much, each day?</h1>
      <div className="sb-choices sb-two">
        {QUANTITIES.map((x) => (
          <button
            key={x.id}
            type="button"
            className={`sb-choice${selected === x.id ? ' is-selected' : ''}`}
            onClick={() => onPick(x.id)}
            aria-pressed={selected === x.id}
          >
            <span className="sb-choice-name">{x.label}</span>
            <span className="sb-choice-rate">{formatINR(quote(milk, x.id, '1m').finalPaise)} / month to start</span>
          </button>
        ))}
      </div>
      <div className="sb-nav">
        <button type="button" className="sb-back" onClick={onBack}>
          ← Back to milk
        </button>
      </div>
    </section>
  );
}

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
      <p className="eyebrow">Step 5 of {STEPS.length}</p>
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
              {t.discountPct > 0 ? <span className="sb-choice-off">save {t.discountPct}%</span> : null}
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

/* ------------------------------------------------------------- 6. start ---- */

interface PlanBody {
  purpose: 'new' | 'renewal';
  kind: MilkKind;
  quantityId: string;
  tenureId: string;
  renewsSubscriptionId?: string;
  startDate?: string;
}

type Load<T> = { kind: 'loading' } | { kind: 'error'; fail: ApiFail } | { kind: 'ok'; data: T };

/** POST /api/checkout/preview, re-run whenever the body changes. */
function usePreview(body: (PlanBody & { useCredit: boolean }) | null, enabled = true): [Load<PreviewJSON>, () => void] {
  const [state, setState] = useState<Load<PreviewJSON>>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const key = body ? JSON.stringify(body) : '';
  useEffect(() => {
    if (!body || !enabled) return;
    let alive = true;
    setState({ kind: 'loading' });
    void postJson<{ preview: PreviewJSON }>('/api/checkout/preview', body).then((r) => {
      if (!alive) return;
      setState(r.ok ? { kind: 'ok', data: r.data.preview } : { kind: 'error', fail: r.fail });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, enabled]);
  return [state, () => setNonce((n) => n + 1)];
}

function StartStep({
  plan,
  renewal,
  choice,
  setChoice,
  error,
  onNext,
  onBack,
}: {
  plan: PlanBody;
  renewal: Extract<RenewalProp, { kind: 'ready' }> | null;
  choice: StartChoice;
  setChoice: (c: StartChoice) => void;
  error: ApiFail | undefined;
  onNext: () => void;
  onBack: () => void;
}) {
  // Ask for the EARLIEST date (no startDate), so the answer is the first open date.
  const { startDate: _omit, ...base } = plan;
  void _omit;
  const [pv, retry] = usePreview({ ...base, useCredit: false });
  const latest = addDaysYMD(istToday(), 30);
  const lockedFirstOpen = error?.code === 'date_locked' ? error.firstOpen : undefined;

  let laterProblem: string | null = null;
  if (pv.kind === 'ok' && choice.mode === 'later') {
    if (!choice.date) laterProblem = 'Pick a date.';
    else if (choice.date < pv.data.firstOpenDate) laterProblem = `The earliest we can start is ${dateLabel(pv.data.firstOpenDate)}.`;
    else if (choice.date > latest) laterProblem = `The first delivery can be at most 30 days away (${dateLabel(latest)}).`;
  }

  return (
    <section className="sb-panel" aria-labelledby="sb-start-h">
      <p className="eyebrow">Step 6 of {STEPS.length}</p>
      <h1 id="sb-start-h">When should it start?</h1>
      <StepError fail={error} />

      {pv.kind === 'loading' ? (
        <p className="sb-secondary">
          <span className="sb-spinner" aria-hidden="true" /> Finding the earliest delivery date…
        </p>
      ) : pv.kind === 'error' ? (
        <>
          <StepError fail={pv.fail} />
          <button type="button" className="sb-btn" onClick={retry}>
            Try again
          </button>
        </>
      ) : renewal ? (
        <>
          <p className="sb-lead">
            Your renewal starts on <b>{dateLabel(pv.data.startDate, true)}</b>
            {pv.data.startDate === addDaysYMD(renewal.endDate, 1)
              ? `, the day after your current plan ends (${dateLabel(renewal.endDate)}).`
              : ' — the earliest date still open for changes, because your current plan has already ended.'}{' '}
            It runs to {dateLabel(pv.data.endDate, true)}.
          </p>
          <div className="sb-nav">
            <button type="button" className="sb-btn" onClick={onNext}>
              Continue
            </button>
            <button type="button" className="sb-back" onClick={onBack}>
              ← Back
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="sb-lead">
            The earliest first delivery is <b>{dateLabel(pv.data.firstOpenDate, true)}</b>.
            {lockedFirstOpen ? ' The date you picked closed while you were choosing.' : ''}
          </p>
          <fieldset className="sb-startopts">
            <legend className="sb-visually-hidden">First delivery date</legend>
            <label className="sb-radio">
              <input
                type="radio"
                name="sb-start"
                checked={choice.mode === 'earliest'}
                onChange={() => setChoice({ mode: 'earliest', date: '' })}
              />
              <span>As early as possible — {dateLabel(pv.data.firstOpenDate)}</span>
            </label>
            <label className="sb-radio">
              <input
                type="radio"
                name="sb-start"
                checked={choice.mode === 'later'}
                onChange={() => setChoice({ mode: 'later', date: choice.date || pv.data.firstOpenDate })}
              />
              <span>A later date (up to 30 days from today)</span>
            </label>
            {choice.mode === 'later' ? (
              <div className="sb-field">
                <label htmlFor="sb-start-date">First delivery on</label>
                <input
                  id="sb-start-date"
                  className="sb-input"
                  type="date"
                  min={pv.data.firstOpenDate}
                  max={latest}
                  value={choice.date}
                  onChange={(e) => setChoice({ mode: 'later', date: e.target.value })}
                  aria-invalid={laterProblem ? true : undefined}
                  aria-describedby={laterProblem ? 'sb-start-err' : undefined}
                />
                {choice.date && !laterProblem ? <p className="sb-hint">{dateLabel(choice.date, true)}</p> : null}
                {laterProblem ? (
                  <em id="sb-start-err" className="sb-fieldnote">
                    {laterProblem}
                  </em>
                ) : null}
              </div>
            ) : null}
          </fieldset>
          <div className="sb-nav">
            <button type="button" className="sb-btn" onClick={onNext} disabled={!!laterProblem}>
              Continue
            </button>
            <button type="button" className="sb-back" onClick={onBack}>
              ← Back to duration
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ 7. review ---- */

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

function ReviewStep({
  plan,
  planLabel,
  pin,
  area,
  addr,
  error,
  clearError,
  onFail,
  onEdit,
}: {
  plan: PlanBody;
  planLabel: string;
  pin: PickedLocation;
  area: Area;
  addr: AddressForm;
  error: ApiFail | undefined;
  clearError: () => void;
  onFail: (f: ApiFail) => void;
  onEdit: (s: Step) => void;
}) {
  const [auth, setAuth] = useState<Auth>({ kind: 'loading' });
  const [authNonce, setAuthNonce] = useState(0);
  const [useCredit, setUseCredit] = useState(false);
  const [whatsapp, setWhatsapp] = useState(false);
  /** only a box the customer actually changed is sent — see startCheckout */
  const [whatsappTouched, setWhatsappTouched] = useState(false);
  const whatsappTouchedRef = useRef(false);
  const [pay, setPay] = useState<Pay>({ kind: 'idle' });
  /** idempotency key, tied to the exact request it was minted for; reused on retry */
  const keyRef = useRef<{ sig: string; key: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setAuth({ kind: 'loading' });
    void callApi<{ authenticated: boolean; mobile?: string; whatsappOptIn?: boolean }>('/api/auth/me').then((r) => {
      if (!alive) return;
      if (!r.ok) setAuth({ kind: 'error', fail: r.fail });
      else {
        setAuth(r.data.authenticated && r.data.mobile ? { kind: 'in', mobile: r.data.mobile } : { kind: 'out' });
        // A returning customer who already opted in sees the box ticked.
        if (r.data.authenticated && r.data.whatsappOptIn === true) setWhatsapp(prev => (whatsappTouchedRef.current ? prev : true));
      }
    });
    return () => {
      alive = false;
    };
  }, [authNonce]);

  const signedIn = auth.kind === 'in';
  const [pv, retryPreview] = usePreview({ ...plan, useCredit }, signedIn);

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
    const sig = JSON.stringify(body);
    if (!keyRef.current || keyRef.current.sig !== sig) keyRef.current = { sig, key: newKey() };
    setPay({ kind: 'creating' });
    const r = await postJson<CheckoutResponse>('/api/checkout', { ...body, idempotencyKey: keyRef.current.key });
    if (!r.ok) {
      setPay({ kind: 'idle' });
      if (r.fail.status === 401) {
        setAuth({ kind: 'out' });
        return;
      }
      if (r.fail.status === 409 && r.fail.code === 'conflict') keyRef.current = null; // key belonged to another request
      onFail(r.fail);
      return;
    }
    if (r.data.razorpay === null) {
      // Paid entirely from credit — the server has already activated it.
      setPay({ kind: 'active', startDate: r.data.preview.startDate, endDate: r.data.preview.endDate, fromCredit: true });
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
      setPay({ kind: 'active', startDate: r.data.startDate, endDate: r.data.endDate, fromCredit: false });
      return;
    }
    // Money moved; our confirmation did not land. Never call this a failure — the
    // Razorpay webhook is the backstop that activates the plan.
    setPay({ kind: 'received', message: r.ok ? null : r.fail.error });
  };

  if (pay.kind === 'active') return <Success {...pay} />;
  if (pay.kind === 'received') return <PaymentReceived message={pay.message} />;

  const zoneText = area.kind === 'yes' ? area.zone : null;

  return (
    <section className="sb-panel" aria-labelledby="sb-review-h">
      <p className="eyebrow">Step 7 of {STEPS.length}</p>
      <h1 id="sb-review-h">Check &amp; pay.</h1>
      <StepError fail={error} />

      <dl className="sb-review">
        <div>
          <dt>Plan</dt>
          <dd>
            {planLabel}{' '}
            <button type="button" className="sb-linkbtn" onClick={() => onEdit(plan.purpose === 'renewal' ? 'qty' : 'milk')}>
              Change
            </button>
          </dd>
        </div>
        <div>
          <dt>Deliver to</dt>
          <dd>
            {details.name} — {details.address}
            {details.landmark ? ` (${details.landmark})` : ''}
            {zoneText ? ` · ${zoneText}` : ''}{' '}
            <button type="button" className="sb-linkbtn" onClick={() => onEdit('address')}>
              Change
            </button>
          </dd>
        </div>
        <div>
          <dt>Pin</dt>
          <dd>
            {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}{' '}
            <button type="button" className="sb-linkbtn" onClick={() => onEdit('where')}>
              Move
            </button>
          </dd>
        </div>
      </dl>

      {area.kind !== 'yes' ? (
        <div className="sb-notice is-err" role="alert">
          <span className="sb-dot" aria-hidden="true" />
          <span>
            We have not confirmed delivery to your pin.{' '}
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
        <OtpForm
          intro="Sign in with your mobile to pay — a one-time code, no password."
          onSignedIn={(mobile) => setAuth({ kind: 'in', mobile })}
        />
      ) : (
        <div className="sb-pay">
          <p className="sb-secondary">
            Signed in as {auth.mobile}.{' '}
            <button
              type="button"
              className="sb-linkbtn"
              disabled={pay.kind !== 'idle'}
              onClick={async () => {
                await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
                keyRef.current = null;
                setAuth({ kind: 'out' });
              }}
            >
              Use a different number
            </button>
          </p>

          {pv.kind === 'loading' ? (
            <p className="sb-secondary">
              <span className="sb-spinner" aria-hidden="true" /> Working out your final amount…
            </p>
          ) : pv.kind === 'error' ? (
            <>
              <StepError fail={pv.fail} />
              <button
                type="button"
                className="sb-btn"
                onClick={() => {
                  const s = stepForFail(pv.fail);
                  if (s !== 'review') onFail(pv.fail);
                  else retryPreview();
                }}
              >
                {stepForFail(pv.fail) === 'review' ? 'Try again' : 'Fix this'}
              </button>
            </>
          ) : (
            <>
              <ul className="sb-lines sb-final">
                <li>
                  <span>First delivery</span>
                  <b>{dateLabel(pv.data.startDate, true)}</b>
                </li>
                <li>
                  <span>Last delivery</span>
                  <b>{dateLabel(pv.data.endDate, true)}</b>
                </li>
                <li>
                  <span>
                    {pv.data.days} days · {pv.data.litres} L
                  </span>
                  <b>{formatINR(pv.data.amountPaise)}</b>
                </li>
                {pv.data.savingPaise > 0 ? (
                  <li className="sb-save">
                    <span>You save</span>
                    <b>{formatINR(pv.data.savingPaise)}</b>
                  </li>
                ) : null}
                {pv.data.creditAppliedPaise > 0 ? (
                  <li className="sb-save">
                    <span>Paid from your credit</span>
                    <b>− {formatINR(pv.data.creditAppliedPaise)}</b>
                  </li>
                ) : null}
                <li className="sb-total">
                  <span>To pay now</span>
                  <b>{formatINR(pv.data.payablePaise)}</b>
                </li>
              </ul>

              {pv.data.creditAvailablePaise > 0 ? (
                <label className="sb-check-row">
                  <input
                    type="checkbox"
                    checked={useCredit}
                    disabled={pay.kind !== 'idle'}
                    onChange={(e) => setUseCredit(e.target.checked)}
                  />
                  <span>Use my credit ({formatINR(pv.data.creditAvailablePaise)} available)</span>
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
                  Send me updates on WhatsApp — order confirmation, the day before the first delivery, and if a
                  delivery is missed or a refund is made. No marketing. You can turn this off any time in your
                  account.
                </span>
              </label>

              {pay.kind === 'ready' ? (
                <>
                  <RazorpayCheckout
                    order={pay.order}
                    mobile={auth.mobile}
                    planLabel={planLabel}
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
                  <span className="sb-spinner" aria-hidden="true" /> Payment received — confirming it with the bank…
                </p>
              ) : (
                <button
                  type="button"
                  className={`sb-btn${pay.kind === 'creating' ? ' is-busy' : ''}`}
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
              )}
              <p className="sb-hint">
                Prepaid, fixed term, no auto-renewal. The amount is worked out on our server — what you see here
                is what you are charged.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Success({ startDate, endDate, fromCredit }: { startDate: string | null; endDate: string | null; fromCredit: boolean }) {
  return (
    <section className="sb-panel">
      <div className="sb-success" role="status">
        <span className="sb-check" aria-hidden="true">
          ✓
        </span>
        <h2>{fromCredit ? 'Done — paid from your credit.' : 'Your plan is confirmed.'}</h2>
        <p className="sb-lead">
          {startDate && endDate ? (
            <>
              Deliveries run from <b>{dateLabel(startDate, true)}</b> to <b>{dateLabel(endDate, true)}</b>.
            </>
          ) : (
            <>Your plan is confirmed.</>
          )}{' '}
          Pause a day or check the schedule in <Link href="/account">My Deliveries</Link>.
        </p>
        <Link className="cta" href="/account">
          Go to my deliveries
        </Link>
      </div>
    </section>
  );
}

function PaymentReceived({ message }: { message: string | null }) {
  return (
    <section className="sb-panel">
      <div className="sb-success" role="status">
        <span className="sb-check" aria-hidden="true">
          ✓
        </span>
        <h2>Payment received.</h2>
        <p className="sb-lead">
          We could not confirm it with the gateway from this page just now{message ? ` (${message})` : ''}. Please{' '}
          <b>do not pay again</b> — the gateway tells us directly, and your plan appears in{' '}
          <Link href="/account">My Deliveries</Link> once it does, usually within a few minutes. If it has not
          appeared in an hour, call <a href={PHONE_HREF}>{PHONE}</a>.
        </p>
        <Link className="cta" href="/account">
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
  const milkLabel = milk ? PRODUCTS.find((p) => p.kind === milk)?.label : null;
  const qtyLabel = qty ? QUANTITIES.find((x) => x.id === qty)?.label : null;
  const termLabel = term ? TENURES.find((t) => t.id === term)?.label : null;
  const areaLine =
    area.kind === 'yes'
      ? area.zone
        ? `Delivers · ${area.zone}`
        : 'Delivers here'
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
          <span>Location</span>
          <b>{areaLine ?? 'no pin yet'}</b>
        </li>
        <li className={address ? undefined : 'is-empty'}>
          <span>Address</span>
          <b>{address || 'not entered'}</b>
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
      <p className="sb-rail-note">Prices are fixed-term and prepaid — one payment, no auto-renewal.</p>
    </div>
  );
}
