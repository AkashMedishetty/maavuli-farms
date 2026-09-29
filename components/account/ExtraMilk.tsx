'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatINR } from '@/lib/pricing';
import { addDaysYMD } from '@/lib/cutoff';
import RazorpayCheckout, { type CheckoutOrder, type RazorpayResponse } from '@/components/RazorpayCheckout';
import { callApi, dayLabel, ErrorNote, newKey, useAction } from './api';

/**
 * Extra milk on one day for one plan: preview (POST /api/extras/preview) → create
 * (POST /api/extras). `razorpay: null` means credit covered it and it is already
 * booked; otherwise Razorpay Checkout opens and the result is confirmed through
 * POST /api/payments/verify (the webhook is the backstop, so a failed verify after
 * payment says "received — confirming", never "failed").
 */

/** Mirrors lib/extras EXTRA_LITRES (that module is server-only). */
const LITRES = [0.5, 1, 1.5, 2] as const;
/** Mirrors lib/extras EXTRA_MAX_DAYS_AHEAD. */
const MAX_AHEAD = 30;

interface Preview {
  date: string;
  kind: 'cow' | 'buffalo';
  litres: number;
  pricePaise: number;
  creditAvailablePaise: number;
  creditAppliedPaise: number;
  payablePaise: number;
  open: boolean;
  firstOpenDate: string;
}

interface Created {
  order: { id: string; status: string; payablePaise: number; date: string | null };
  razorpay: CheckoutOrder | null;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'preview'; preview: Preview; key: string }
  | { kind: 'pay'; order: CheckoutOrder; preview: Preview }
  | { kind: 'done'; message: string };

export function ExtraMilk({
  subscriptionId,
  planKind,
  firstOpenDate,
  mobile,
}: {
  subscriptionId: string;
  planKind: 'cow' | 'buffalo';
  firstOpenDate: string;
  mobile: string;
}) {
  const router = useRouter();
  const [date, setDate] = useState(firstOpenDate);
  const [litres, setLitres] = useState<number>(1);
  const [kind, setKind] = useState<'cow' | 'buffalo'>(planKind);
  const [useCredit, setUseCredit] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [payError, setPayError] = useState<string | null>(null);
  const act = useAction();

  const body = { subscriptionId, date, kind, litres, useCredit };

  const doPreview = async () => {
    const r = await act.run(() => callApi<{ preview: Preview }>('/api/extras/preview', { body }));
    if (r) setPhase({ kind: 'preview', preview: r.preview, key: newKey('extra') });
  };

  const doCreate = async (key: string, preview: Preview) => {
    const r = await act.run(() => callApi<Created>('/api/extras', { body: { ...body, idempotencyKey: key } }));
    if (!r) return;
    if (!r.razorpay) {
      setPhase({ kind: 'done', message: `Booked: ${litres} L extra on ${dayLabel(date)}, paid from your credit.` });
      router.refresh();
    } else {
      setPayError(null);
      setPhase({ kind: 'pay', order: r.razorpay, preview });
    }
  };

  const onPaid = useCallback(
    async (resp: RazorpayResponse) => {
      const r = await act.run(() => callApi<{ status: string }>('/api/payments/verify', { body: resp }));
      setPhase({
        kind: 'done',
        message: r
          ? `Paid. ${litres} L extra is booked for ${dayLabel(date)}.`
          : `Payment received — we are confirming it. It will show here shortly; please do not pay again.`,
      });
      router.refresh();
    },
    [act, date, litres, router],
  );

  const onPayError = useCallback((m: string) => setPayError(m), []);

  if (phase.kind === 'done') {
    return (
      <div className="acct-stack">
        <p className="acct-ok" role="status">{phase.message}</p>
        <button type="button" className="acct-btn acct-btn-ghost" onClick={() => setPhase({ kind: 'form' })}>
          Add another
        </button>
      </div>
    );
  }

  if (phase.kind === 'pay') {
    return (
      <div className="acct-stack">
        <p>
          Pay {formatINR(phase.preview.payablePaise)} for {phase.preview.litres} L on {dayLabel(phase.preview.date)}.
        </p>
        <RazorpayCheckout
          order={phase.order}
          mobile={mobile}
          planLabel={`Extra ${phase.preview.litres} L ${phase.preview.kind} milk, ${dayLabel(phase.preview.date)}`}
          onPaid={(r) => void onPaid(r)}
          onError={onPayError}
        />
        {act.pending && <p className="acct-muted" aria-live="polite">Confirming your payment…</p>}
        {payError && <p className="acct-err" role="alert">{payError}</p>}
        <ErrorNote fail={act.fail} />
        <button type="button" className="acct-btn acct-btn-ghost" onClick={() => setPhase({ kind: 'form' })} disabled={act.pending}>
          Back
        </button>
      </div>
    );
  }

  const editing = phase.kind === 'form';
  return (
    <div className="acct-stack">
      <div className="acct-grid2">
        <label className="acct-field">
          <span>Date</span>
          <input
            type="date"
            value={date}
            min={firstOpenDate}
            max={addDaysYMD(firstOpenDate, MAX_AHEAD)}
            onChange={(e) => { setDate(e.target.value); setPhase({ kind: 'form' }); }}
            required
          />
        </label>
        <label className="acct-field">
          <span>How much</span>
          <select value={litres} onChange={(e) => { setLitres(Number(e.target.value)); setPhase({ kind: 'form' }); }}>
            {LITRES.map((l) => (
              <option key={l} value={l}>
                {l} L
              </option>
            ))}
          </select>
        </label>
        <label className="acct-field">
          <span>Milk</span>
          <select value={kind} onChange={(e) => { setKind(e.target.value === 'buffalo' ? 'buffalo' : 'cow'); setPhase({ kind: 'form' }); }}>
            <option value="cow">Cow</option>
            <option value="buffalo">Buffalo</option>
          </select>
        </label>
        <label className="acct-check">
          <input type="checkbox" checked={useCredit} onChange={(e) => { setUseCredit(e.target.checked); setPhase({ kind: 'form' }); }} />
          <span>Use my credit first</span>
        </label>
      </div>

      {editing ? (
        <button type="button" className="acct-btn" onClick={() => void doPreview()} disabled={act.pending || !date}>
          {act.pending ? 'Checking…' : 'Check price'}
        </button>
      ) : (
        <>
          <dl className="acct-dl">
            <dt>{phase.preview.litres} L {phase.preview.kind} on {dayLabel(phase.preview.date)}</dt>
            <dd>{formatINR(phase.preview.pricePaise)}</dd>
            {phase.preview.creditAppliedPaise > 0 && (
              <>
                <dt>From your credit</dt>
                <dd>− {formatINR(phase.preview.creditAppliedPaise)}</dd>
              </>
            )}
            <dt className="acct-dl-total">To pay now</dt>
            <dd className="acct-dl-total">{formatINR(phase.preview.payablePaise)}</dd>
          </dl>
          {phase.preview.open ? (
            <button type="button" className="acct-btn" onClick={() => void doCreate(phase.key, phase.preview)} disabled={act.pending}>
              {act.pending
                ? 'Booking…'
                : phase.preview.payablePaise === 0
                  ? 'Book it (paid from credit)'
                  : `Book and pay ${formatINR(phase.preview.payablePaise)}`}
            </button>
          ) : (
            <p className="acct-err" role="alert">
              That date is closed for changes. The earliest date you can book is {dayLabel(phase.preview.firstOpenDate)}.
            </p>
          )}
        </>
      )}
      <ErrorNote fail={act.fail} />
      <p className="acct-muted">Delivered with your usual milk, to this plan’s address. One extra per day per plan.</p>
    </div>
  );
}
