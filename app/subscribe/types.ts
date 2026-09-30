/**
 * Plain-JSON shapes shared by the /subscribe server page and its client flow.
 * Types only — safe for both sides of the server/client boundary.
 */
import type { AddressParts } from '@/lib/models';
import type { MilkKind } from '@/lib/pricing';

export interface RenewalDetails {
  name: string;
  address: string;
  landmark?: string;
  instructions?: string;
  addressParts?: AddressParts;
  location?: { lat: number; lng: number };
}

/** Live ops times, already formatted ("4:00 PM"), so the flow never hardcodes them. */
export interface DayRuleLabels {
  cutoff: string;
  windowStart: string;
  windowEnd: string;
}

/** What `/subscribe?renew=<id>` resolved to on the server. */
export type RenewalProp =
  | { kind: 'none' }
  | {
      kind: 'ready';
      subscriptionId: string;
      /** last delivery date of the plan being renewed (YYYY-MM-DD) */
      endDate: string;
      /** the start the server would give the renewal right now */
      renewStartDate: string;
      milk: MilkKind;
      /** null when the old order could not be matched to a current plan id */
      quantityId: string | null;
      tenureId: string | null;
      details: RenewalDetails;
    }
  | { kind: 'signed_out' }
  | { kind: 'not_found' }
  | { kind: 'not_renewable'; reason: string }
  | { kind: 'unavailable'; missing: string[] };

/** A failed API call, normalised from the documented error body. */
export interface ApiFail {
  status: number;
  error: string;
  issues: string[];
  code?: string;
  firstOpen?: string;
  missing?: string[];
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; fail: ApiFail };

/** CheckoutPreview from lib/orders, as JSON. */
export interface PreviewJSON {
  amountPaise: number;
  originalPaise: number;
  savingPaise: number;
  perLitrePaise: number;
  days: number;
  litres: number;
  startDate: string;
  endDate: string;
  firstOpenDate: string;
  creditAvailablePaise: number;
  creditAppliedPaise: number;
  payablePaise: number;
}
