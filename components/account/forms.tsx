'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import LocationPicker, { type PickedLocation } from '@/components/LocationPicker';
import type { AddressParts, Lang, TicketKind } from '@/lib/models';
import { callApi, dayLabel, ErrorNote, useAction } from './api';

/* ================================================================ report == */

const KINDS: { v: TicketKind; label: string }[] = [
  { v: 'not_received', label: 'Milk not received' },
  { v: 'spoiled', label: 'Milk spoiled' },
  { v: 'quantity', label: 'Wrong quantity' },
  { v: 'other', label: 'Something else' },
];

/** POST /api/account/tickets for one of the customer's own deliveries. */
export function ReportProblem({ deliveryId, date }: { deliveryId: string; date: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<TicketKind>('not_received');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const act = useAction();

  if (sent) return <p className="acct-ok" role="status">Thanks — our team will look into it. You will see the reply under “Your reports”.</p>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => callApi('/api/account/tickets', { body: { deliveryId, kind, note } }));
    if (r) {
      setSent(true);
      router.refresh();
    }
  };

  const len = note.trim().length;
  return (
    <form className="acct-stack" onSubmit={(e) => void submit(e)}>
      <label className="acct-field">
        <span>What went wrong on {dayLabel(date)}?</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as TicketKind)}>
          {KINDS.map((k) => (
            <option key={k.v} value={k.v}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="acct-field">
        <span>Tell us a little more</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} minLength={3} maxLength={500} rows={3} required />
        <small className="acct-muted">{len}/500</small>
      </label>
      <button type="submit" className="acct-btn" disabled={act.pending || len < 3}>
        {act.pending ? 'Sending…' : 'Send report'}
      </button>
      <ErrorNote fail={act.fail} />
    </form>
  );
}

/* ================================================================== upi == */

/** POST /api/account/refunds/[id]/upi for an awaiting_upi refund. */
export function RefundUpi({ refundId }: { refundId: string }) {
  const router = useRouter();
  const [upi, setUpi] = useState('');
  const act = useAction();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => callApi(`/api/account/refunds/${refundId}/upi`, { body: { upiId: upi.trim() } }));
    if (r) router.refresh();
  };

  return (
    <form className="acct-stack" onSubmit={(e) => void submit(e)}>
      <label className="acct-field">
        <span>Your UPI id</span>
        <input
          type="text"
          inputMode="email"
          autoComplete="off"
          placeholder="name@bank"
          value={upi}
          onChange={(e) => setUpi(e.target.value)}
          maxLength={100}
          required
        />
      </label>
      <button type="submit" className="acct-btn" disabled={act.pending || !upi.includes('@')}>
        {act.pending ? 'Saving…' : 'Send UPI id'}
      </button>
      <ErrorNote fail={act.fail} />
    </form>
  );
}

/* ========================================================== preferences == */

export interface PrefsValue {
  whatsappOptIn: boolean;
  missedDeliveryPreference: 'makeup_day' | 'credit';
  notifyDailyDelivered: boolean;
  lang: Lang;
}

/** POST /api/account/preferences with only the fields that changed. */
export function PreferencesForm({ initial }: { initial: PrefsValue }) {
  const router = useRouter();
  const [v, setV] = useState<PrefsValue>(initial);
  const [saved, setSaved] = useState(false);
  const act = useAction();

  const changed: Partial<PrefsValue> = {};
  (Object.keys(v) as (keyof PrefsValue)[]).forEach((k) => {
    if (v[k] !== initial[k]) (changed as Record<string, unknown>)[k] = v[k];
  });
  const dirty = Object.keys(changed).length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const r = await act.run(() => callApi('/api/account/preferences', { body: changed }));
    if (r) {
      setSaved(true);
      router.refresh();
    }
  };

  const set = <K extends keyof PrefsValue>(k: K, val: PrefsValue[K]) => {
    setSaved(false);
    setV((cur) => ({ ...cur, [k]: val }));
  };

  return (
    <form className="acct-stack" onSubmit={(e) => void submit(e)}>
      <label className="acct-check">
        <input type="checkbox" checked={v.whatsappOptIn} onChange={(e) => set('whatsappOptIn', e.target.checked)} />
        <span>
          Send me WhatsApp updates (order confirmations, missed deliveries, refunds). Without this we cannot message you.
        </span>
      </label>
      <label className="acct-check">
        <input
          type="checkbox"
          checked={v.notifyDailyDelivered}
          onChange={(e) => set('notifyDailyDelivered', e.target.checked)}
          disabled={!v.whatsappOptIn}
        />
        <span>Also message me every morning the milk is delivered, with the doorstep photo</span>
      </label>
      <fieldset className="acct-fieldset">
        <legend>If we miss a delivery</legend>
        <label className="acct-check">
          <input
            type="radio"
            name="missed"
            checked={v.missedDeliveryPreference === 'makeup_day'}
            onChange={() => set('missedDeliveryPreference', 'makeup_day')}
          />
          <span>Add a make-up day at the end of my plan</span>
        </label>
        <label className="acct-check">
          <input
            type="radio"
            name="missed"
            checked={v.missedDeliveryPreference === 'credit'}
            onChange={() => set('missedDeliveryPreference', 'credit')}
          />
          <span>Keep the value as credit</span>
        </label>
      </fieldset>
      <label className="acct-field">
        <span>Message language</span>
        <select value={v.lang} onChange={(e) => set('lang', e.target.value === 'te' ? 'te' : 'en')}>
          <option value="en">English</option>
          <option value="te">తెలుగు (Telugu)</option>
        </select>
      </label>
      <button type="submit" className="acct-btn" disabled={act.pending || !dirty}>
        {act.pending ? 'Saving…' : 'Save preferences'}
      </button>
      {saved && !dirty && <p className="acct-ok" role="status">Saved.</p>}
      <ErrorNote fail={act.fail} />
    </form>
  );
}

/* ============================================================== address == */

export interface AddressValue {
  location: { lat: number; lng: number } | null;
  addressParts: AddressParts;
  landmark: string;
  instructions: string;
}

interface AddressResult {
  effectiveFrom: string;
  zoneName: string;
  plansUpdated: number;
  address: string;
}

/** POST /api/account/address: move the doorstep pin and the address lines. */
export function AddressForm({ initial }: { initial: AddressValue }) {
  const router = useRouter();
  const [pin, setPin] = useState<PickedLocation | null>(initial.location);
  const [parts, setParts] = useState<AddressParts>(initial.addressParts);
  const [landmark, setLandmark] = useState(initial.landmark);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [done, setDone] = useState<AddressResult | null>(null);
  const act = useAction();

  const part = (k: keyof AddressParts) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setDone(null);
    setParts((cur) => ({ ...cur, [k]: e.target.value }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin) return;
    const r = await act.run(() =>
      callApi<AddressResult>('/api/account/address', {
        body: { location: { lat: pin.lat, lng: pin.lng }, addressParts: parts, landmark, instructions },
      }),
    );
    if (r) {
      setDone(r);
      router.refresh();
    }
  };

  return (
    <form className="acct-stack" onSubmit={(e) => void submit(e)}>
      <p className="acct-muted">
        Put the pin exactly on your door. The change applies from the first day still open for changes; deliveries
        already confirmed keep the old address.
      </p>
      <LocationPicker value={pin} onChange={(p) => { setDone(null); setPin(p); }} />
      <div className="acct-grid2">
        <label className="acct-field">
          <span>Flat / house number *</span>
          <input value={parts.house} onChange={part('house')} maxLength={100} required autoComplete="address-line1" />
        </label>
        <label className="acct-field">
          <span>Floor</span>
          <input value={parts.floor ?? ''} onChange={part('floor')} maxLength={40} />
        </label>
        <label className="acct-field">
          <span>Tower / block</span>
          <input value={parts.building ?? ''} onChange={part('building')} maxLength={100} />
        </label>
        <label className="acct-field">
          <span>Society / street</span>
          <input value={parts.society ?? ''} onChange={part('society')} maxLength={150} autoComplete="address-line2" />
        </label>
        <label className="acct-field">
          <span>Area</span>
          <input value={parts.area ?? ''} onChange={part('area')} maxLength={150} />
        </label>
        <label className="acct-field">
          <span>Pincode</span>
          <input
            value={parts.pincode ?? ''}
            onChange={part('pincode')}
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoComplete="postal-code"
          />
        </label>
      </div>
      <label className="acct-field">
        <span>Landmark</span>
        <input value={landmark} onChange={(e) => { setDone(null); setLandmark(e.target.value); }} maxLength={200} />
      </label>
      <label className="acct-field">
        <span>Instructions for the delivery partner</span>
        <input value={instructions} onChange={(e) => { setDone(null); setInstructions(e.target.value); }} maxLength={300} />
      </label>
      <button type="submit" className="acct-btn" disabled={act.pending || !pin || !parts.house.trim()}>
        {act.pending ? 'Saving address…' : 'Save address'}
      </button>
      {!pin && <p className="acct-muted">Drop the pin on your door to save.</p>}
      {done && (
        <p className="acct-ok" role="status">
          Saved. From {dayLabel(done.effectiveFrom)} your milk goes to {done.address} ({done.zoneName}).
        </p>
      )}
      <ErrorNote fail={act.fail} />
    </form>
  );
}
