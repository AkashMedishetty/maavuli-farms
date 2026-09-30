/**
 * Client-side helpers for the /subscribe flow. Pure (no React, no server imports).
 */
import type { ApiFail, ApiResult } from './types';

/* ------------------------------------------------------------------ steps -- */

/** The three screens: where (pin + door), plan (milk, amount, length, start), pay. */
export type FlowStep = 'where' | 'plan' | 'pay';
export const FLOW_STEPS: readonly FlowStep[] = ['where', 'plan', 'pay'];

export function isFlowStep(v: unknown): v is FlowStep {
  return v === 'where' || v === 'plan' || v === 'pay';
}

/** Which screen an API failure belongs to, so the error shows next to what caused it. */
export function stepForFail(f: ApiFail): FlowStep {
  // Machine codes first (lib/errors ValidationError.code): a copy edit on the server
  // can never misroute these.
  switch (f.code) {
    case 'outside_zone':
    case 'details_incomplete':
      return 'where';
    case 'date_locked':
    case 'start_invalid':
    case 'plan_invalid':
      return 'plan';
    case 'not_renewable':
      return 'pay';
  }
  // Fallback for errors without a code.
  const text = `${f.error} ${f.issues.join(' ')}`.toLowerCase();
  if (f.status === 400) {
    if (/delivery area|delivery zone|drop a pin|pin on the map/.test(text)) return 'where';
    if (/delivery details|name for the delivery|delivery address|addressparts|house|pincode/.test(text)) return 'where';
    if (/first delivery|startdate/.test(text)) return 'plan';
    if (/kind|quantityid|tenureid|plan selection|milk/.test(text)) return 'plan';
  }
  return 'pay';
}

export function isOutsideZone(f: ApiFail): boolean {
  if (f.code === 'outside_zone') return true;
  return f.status === 400 && /delivery area|delivery zone/i.test(`${f.error} ${f.issues.join(' ')}`);
}

/** "+91 98000 00101" for a 10-digit Indian mobile; anything else unchanged. */
export function formatMobile(m: string): string {
  const d = m.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  return /^\d{10}$/.test(d) ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : m;
}

/** fetch JSON and normalise every failure (network included) to ApiFail. */
export async function callApi<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return {
      ok: false,
      fail: { status: 0, error: 'Could not reach our server. Check your connection and try again.', issues: [] },
    };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && body) return { ok: true, data: body as T };
  const b = body ?? {};
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    ok: false,
    fail: {
      status: res.status,
      error:
        typeof b.error === 'string' && b.error
          ? b.error
          : res.ok
            ? 'The server sent an unreadable answer. Please try again.'
            : 'Something went wrong on our side. Please try again.',
      issues: strings(b.issues),
      ...(typeof b.code === 'string' ? { code: b.code } : {}),
      ...(typeof b.firstOpen === 'string' ? { firstOpen: b.firstOpen } : {}),
      ...(Array.isArray(b.missing) ? { missing: strings(b.missing) } : {}),
    },
  };
}

export function postJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  return callApi<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** "Thu 2 Oct" for a YYYY-MM-DD, in Asia/Kolkata. */
export function dateLabel(ymd: string, withYear = false): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'Asia/Kolkata',
  }).format(new Date(Date.UTC(y, m - 1, d, 6)));
}

/** Today's date in India, YYYY-MM-DD. */
export function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

export function addDaysYMD(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** A fresh idempotency key. crypto.randomUUID needs a secure context; fall back to getRandomValues. */
export function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------------- address -- */

export interface AddressForm {
  name: string;
  house: string;
  floor: string;
  building: string;
  society: string;
  area: string;
  pincode: string;
  landmark: string;
  instructions: string;
}

export const EMPTY_ADDRESS: AddressForm = {
  name: '',
  house: '',
  floor: '',
  building: '',
  society: '',
  area: '',
  pincode: '',
  landmark: '',
  instructions: '',
};

/** The one-line address a rider reads out loud, built from the parts. */
export function composeAddress(a: AddressForm): string {
  const floor = a.floor.trim();
  const parts = [
    a.house.trim(),
    floor ? (/floor/i.test(floor) ? floor : `Floor ${floor}`) : '',
    a.building.trim(),
    a.society.trim(),
    a.area.trim(),
  ].filter(Boolean);
  const pin = a.pincode.trim();
  return `${parts.join(', ')}${pin ? ` – ${pin}` : ''}`;
}

/** Field → problem. Empty object = valid. Mirrors the server's checks (name ≥ 2, address ≥ 10). */
export function addressProblems(a: AddressForm): Partial<Record<keyof AddressForm | 'address', string>> {
  const p: Partial<Record<keyof AddressForm | 'address', string>> = {};
  if (a.name.trim().length < 2) p.name = 'Who should the rider ask for?';
  if (!a.house.trim()) p.house = 'The flat or house number is needed to find your door.';
  if (!a.society.trim() && !a.area.trim()) p.society = 'Add the society, building or street (or the area).';
  if (a.pincode.trim() && !/^\d{6}$/.test(a.pincode.trim())) p.pincode = 'A pincode is 6 digits (or leave it empty).';
  if (!p.house && !p.society && composeAddress(a).length < 10) p.address = 'Please add a little more of the address.';
  return p;
}
