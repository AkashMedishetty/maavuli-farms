/**
 * The half-finished sign-up, kept in THIS browser tab (sessionStorage).
 *
 * Without it, a refresh, an Android tab reload after switching apps, or a trip to
 * another page threw away the pin, the address and the plan. It is cleared when the
 * plan is paid for, and the browser drops it when the tab closes. The privacy page
 * says so.
 *
 * Nothing read back is trusted: every field is re-validated here, and the server
 * re-checks everything at checkout anyway. Pure apart from the three storage
 * wrappers at the bottom, so the parser is unit-tested (scripts/verify-subscribe.ts).
 */
import { PRODUCTS, QUANTITIES, TENURES, type MilkKind } from '@/lib/pricing';
import { EMPTY_ADDRESS, isFlowStep, type AddressForm, type FlowStep } from './lib';

export const DRAFT_KEY = 'mv-subscribe-draft';
const VERSION = 1;
/** An older draft is dropped rather than resumed. */
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Same limits as the inputs (and the server). */
const ADDRESS_MAX: Record<keyof AddressForm, number> = {
  name: 100,
  house: 100,
  floor: 40,
  building: 120,
  society: 120,
  area: 120,
  pincode: 6,
  landmark: 300,
  instructions: 500,
};

export interface DraftPin {
  lat: number;
  lng: number;
  accuracyM?: number;
  label?: string;
}

export interface Draft {
  step: FlowStep;
  pin: DraftPin | null;
  addr: AddressForm;
  milk: MilkKind | null;
  qty: string | null;
  term: string | null;
  start: { mode: 'earliest' | 'later'; date: string };
  /** the customer has seen the pay screen, so "Continue" returns there */
  reachedPay: boolean;
  /** the checkout idempotency key and the exact request it was minted for */
  payKey: { sig: string; key: string } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parsePin(v: unknown): DraftPin | null {
  if (!isObj(v) || !finite(v.lat) || !finite(v.lng)) return null;
  if (Math.abs(v.lat) > 90 || Math.abs(v.lng) > 180) return null;
  return {
    lat: v.lat,
    lng: v.lng,
    ...(finite(v.accuracyM) && v.accuracyM >= 0 ? { accuracyM: Math.round(v.accuracyM) } : {}),
    ...(typeof v.label === 'string' && v.label.trim() ? { label: v.label.slice(0, 200) } : {}),
  };
}

function parseAddress(v: unknown): AddressForm {
  const src = isObj(v) ? v : {};
  const out: AddressForm = { ...EMPTY_ADDRESS };
  for (const k of Object.keys(ADDRESS_MAX) as (keyof AddressForm)[]) {
    const s = src[k];
    if (typeof s === 'string') out[k] = s.slice(0, ADDRESS_MAX[k]);
  }
  return out;
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;

/** A stored draft, or null when it is missing, unreadable, stale or from another version. */
export function parseDraft(raw: string | null, now: number = Date.now()): Draft | null {
  if (!raw) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(j) || j.v !== VERSION || !finite(j.savedAt)) return null;
  if (now - j.savedAt > DRAFT_MAX_AGE_MS || j.savedAt - now > 60_000) return null;

  const pin = parsePin(j.pin);
  const milk = oneOf(j.milk, PRODUCTS.map((p) => p.kind));
  const qty = oneOf(j.qty, QUANTITIES.map((q) => q.id));
  const term = oneOf(j.term, TENURES.map((t) => t.id));
  const s = isObj(j.start) ? j.start : {};
  const date = typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : '';
  const start = s.mode === 'later' && date ? { mode: 'later' as const, date } : { mode: 'earliest' as const, date: '' };
  const k = isObj(j.payKey) ? j.payKey : null;
  const payKey =
    k && typeof k.sig === 'string' && typeof k.key === 'string' && k.key.length >= 8 && k.key.length <= 100 && k.sig.length <= 4000
      ? { sig: k.sig, key: k.key }
      : null;

  // Never resume past a screen whose inputs are missing.
  let step: FlowStep = isFlowStep(j.step) ? j.step : 'where';
  if (!pin) step = 'where';
  else if (step === 'pay' && !(milk && qty && term)) step = 'plan';

  return {
    step,
    pin,
    addr: parseAddress(j.addr),
    milk,
    qty,
    term,
    start,
    reachedPay: j.reachedPay === true,
    payKey,
  };
}

export function serializeDraft(d: Draft, now: number = Date.now()): string {
  return JSON.stringify({ v: VERSION, savedAt: now, ...d });
}

/* The only impure part. Storage can be missing, full or blocked (private modes). */

export function readDraft(): Draft | null {
  try {
    return parseDraft(window.sessionStorage.getItem(DRAFT_KEY));
  } catch {
    return null;
  }
}

export function writeDraft(d: Draft): void {
  try {
    window.sessionStorage.setItem(DRAFT_KEY, serializeDraft(d));
  } catch {
    /* not saved: the flow still works, it just will not survive a reload */
  }
}

export function clearDraft(): void {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* nothing to clear */
  }
}
