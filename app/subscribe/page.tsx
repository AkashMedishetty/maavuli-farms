'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PRODUCTS, QUANTITIES, TENURES, quote, formatINR, type MilkKind } from '@/lib/pricing';
import { SERVICEABLE_PINCODES, CONTACT } from '@/lib/content';

/**
 * The funnel, in the client's own words: "people who want cow click on cow and
 * then it should show what are the options under cow... one after one it should
 * get selected and then in the end it should show me the cost."
 *
 * One decision per screen, price revealed LAST.
 *
 * The pincode comes FIRST, which is a change I pushed for. Her described order was
 * milk -> quantity -> duration -> price. If serviceability is only checked after
 * that, a customer configures a ₹35,190 year and *then* learns we don't deliver to
 * them: full effort, zero payoff, guaranteed bounce. Pincode is also the
 * authoritative check — reverse-geocoding a district is fuzzy, a pincode is a lookup.
 *
 * And while SERVICEABLE_PINCODES is empty we do NOT take money. An unconfirmed
 * area means capture interest, not payment.
 */

type Step = 'area' | 'milk' | 'qty' | 'term' | 'done';

export default function SubscribePage() {
  const [step, setStep] = useState<Step>('area');
  const [pin, setPin] = useState('');
  const [areaState, setAreaState] = useState<'unknown' | 'ok' | 'no' | 'unconfirmed'>('unknown');
  const [milk, setMilk] = useState<MilkKind | null>(null);
  const [qty, setQty] = useState<string | null>(null);
  const [term, setTerm] = useState<string | null>(null);

  const q = useMemo(
    () => (milk && qty && term ? quote(milk, qty, term) : null),
    [milk, qty, term]
  );

  const checkArea = () => {
    const clean = pin.replace(/\D/g, '');
    if (clean.length !== 6) return;
    if (SERVICEABLE_PINCODES.length === 0) {
      // We have no pincode list. Saying "yes" here would be inventing coverage.
      setAreaState('unconfirmed');
    } else {
      setAreaState(SERVICEABLE_PINCODES.includes(clean) ? 'ok' : 'no');
    }
    setStep('milk');
  };

  const steps: Step[] = ['area', 'milk', 'qty', 'term', 'done'];
  const idx = steps.indexOf(step);

  return (
    <main className="sub">
      <div className="sub-rail" aria-hidden="true">
        {steps.slice(0, 4).map((s, n) => (
          <span key={s} className={n <= idx ? 'on' : undefined} />
        ))}
      </div>

      {step === 'area' && (
        <section className="sub-step">
          <p className="eyebrow">Step 1 of 4</p>
          <h1>Where should it arrive?</h1>
          <p className="sub-help">
            We check this first, before anything else — so you never build a plan we
            cannot deliver.
          </p>
          <div className="sub-pin">
            <input
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={6}
              placeholder="6-digit pincode"
              value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => e.key === 'Enter' && checkArea()}
              aria-label="Delivery pincode"
            />
            <button className="cta" onClick={checkArea} disabled={pin.replace(/\D/g, '').length !== 6}>
              Check
            </button>
          </div>
        </section>
      )}

      {step === 'milk' && (
        <section className="sub-step">
          {areaState === 'unconfirmed' && (
            <p className="sub-notice">
              Our delivery area is <span className="pending">not published yet</span>. Build
              your plan below and we will confirm {pin} before anything is charged.
            </p>
          )}
          {areaState === 'no' && (
            <p className="sub-notice">
              We do not deliver to {pin} yet. You can still tell us what you want and we
              will get in touch when we reach you.
            </p>
          )}
          {areaState === 'ok' && <p className="sub-notice ok">Yes — we deliver to {pin}.</p>}

          <p className="eyebrow">Step 2 of 4</p>
          <h1>Which milk?</h1>
          <div className="sub-choices">
            {PRODUCTS.map(p => (
              <button
                key={p.kind}
                className="sub-choice"
                onClick={() => { setMilk(p.kind); setStep('qty'); }}
              >
                <span className="sub-choice-name">{p.label}</span>
                {/* breedClaim stays null until confirmed — A2 would be a headline,
                    but asserting it unverified is inventing a fact */}
                {p.breedClaim && <span className="eyebrow">{p.breedClaim}</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 'qty' && milk && (
        <section className="sub-step">
          <p className="eyebrow">Step 3 of 4</p>
          <h1>How much, each day?</h1>
          <div className="sub-choices">
            {QUANTITIES.map(x => (
              <button key={x.id} className="sub-choice" onClick={() => { setQty(x.id); setStep('term'); }}>
                <span className="sub-choice-name">{x.label}</span>
              </button>
            ))}
          </div>
          <button className="sub-back" onClick={() => setStep('milk')}>← Back</button>
        </section>
      )}

      {step === 'term' && milk && qty && (
        <section className="sub-step">
          <p className="eyebrow">Step 4 of 4</p>
          <h1>For how long?</h1>
          <div className="sub-choices sub-terms">
            {TENURES.map(t => {
              const tq = quote(milk, qty, t.id);
              return (
                <button key={t.id} className="sub-choice" onClick={() => { setTerm(t.id); setStep('done'); }}>
                  <span className="sub-choice-name">{t.label}</span>
                  <span className="sub-choice-rate">{formatINR(tq.perLitrePaise)} / litre</span>
                  {t.discountPct > 0 && <span className="sub-choice-off">save {t.discountPct}%</span>}
                </button>
              );
            })}
          </div>
          <button className="sub-back" onClick={() => setStep('qty')}>← Back</button>
        </section>
      )}

      {step === 'done' && q && (
        <section className="sub-step">
          <p className="eyebrow">Your plan</p>
          <h1>{formatINR(q.finalPaise)}</h1>
          <ul className="sub-summary">
            <li><span>Milk</span><b>{PRODUCTS.find(p => p.kind === q.kind)?.label}</b></li>
            <li><span>Each day</span><b>{QUANTITIES.find(x => x.id === q.quantityId)?.label}</b></li>
            <li><span>Term</span><b>{TENURES.find(t => t.id === q.tenureId)?.label} · {q.days} days</b></li>
            <li><span>Total milk</span><b>{q.litres} litres</b></li>
            <li><span>Rate</span><b>{formatINR(q.perLitrePaise)} / litre</b></li>
            {q.savingPaise > 0 && (
              <li className="sub-save"><span>You save</span><b>{formatINR(q.savingPaise)}</b></li>
            )}
          </ul>

          {/* No payment button. Razorpay is not wired, the refund policy is not
              published (Razorpay requires it to activate), and the delivery area is
              unconfirmed. A dead "Pay" button would be the dishonest option. */}
          <div className="sub-next">
            <p className="sub-notice">
              Checkout is <span className="pending">not live yet</span> — the payment
              gateway needs the published refund policy and your confirmed delivery area
              first. Send us this plan and we will set it up with you directly.
            </p>
            <a
              className="cta"
              href={`mailto:${CONTACT.email}?subject=${encodeURIComponent('Subscription: ' + (PRODUCTS.find(p => p.kind === q.kind)?.label ?? ''))}&body=${encodeURIComponent(
                `Pincode: ${pin}\nMilk: ${PRODUCTS.find(p => p.kind === q.kind)?.label}\n` +
                `Quantity: ${QUANTITIES.find(x => x.id === q.quantityId)?.label}\n` +
                `Term: ${TENURES.find(t => t.id === q.tenureId)?.label}\nTotal: ${formatINR(q.finalPaise)}`
              )}`}
            >
              Send this plan
            </a>
            <p className="sub-help">
              or call <a href={`tel:${CONTACT.phones[0]?.replace(/\s/g, '')}`}>{CONTACT.phones[0]}</a>
            </p>
          </div>

          <button className="sub-back" onClick={() => { setStep('area'); setMilk(null); setQty(null); setTerm(null); }}>
            ← Start again
          </button>
        </section>
      )}

      <p className="sub-foot">
        <Link href="/plans">See every plan and price</Link>
      </p>
    </main>
  );
}
