/**
 * DRAFT legal assumptions — the values chosen so the policies actually FUNCTION,
 * versus the values the client has genuinely confirmed.
 *
 * The project rule is that nothing unconfirmed is presented as fact. But a refund
 * policy with no timeframes is useless for Razorpay's activation review, which is
 * what is needed right now. The resolution is NOT to invent facts and NOT to ship
 * an empty page — it is to write complete, sensible commercial defaults and mark
 * every value that WE chose (rather than were told) as a visible DRAFT assumption.
 *
 *   - Everything in DRAFT_ASSUMPTIONS is a proposed default, shown with a draft
 *     chip and collected in the "To confirm before we go live" block on every
 *     legal page.
 *   - Anything the business has actually confirmed lives in lib/content.ts
 *     (BRAND, CONTACT). It is never restated here as if it were our decision.
 *   - Facts we do NOT have (FSSAI licence number, serviceable pincode list) are
 *     absent here on purpose and continue to render as their existing pending
 *     states. They are never given a placeholder value.
 *
 * When the client confirms a value, move it out of here into a plain statement and
 * drop it from the "To confirm" block.
 */

/** A single value we chose rather than were told. `page` groups it per policy. */
export interface DraftAssumption {
  id: string;
  /** Which policy surfaces it, for the shared "To confirm" block. */
  page: 'terms' | 'refunds' | 'shipping' | 'privacy' | 'all';
  label: string;
  /** The proposed default, in plain words. */
  value: string;
}

export const DRAFT_ASSUMPTIONS: readonly DraftAssumption[] = [
  // ---- delivery / shipping -------------------------------------------------
  {
    id: 'delivery-window',
    page: 'shipping',
    label: 'Daily delivery window',
    value: 'Between 5:00 AM and 8:00 AM, every morning including weekends.',
  },
  {
    id: 'order-cutoff',
    page: 'shipping',
    label: 'Cut-off for next-morning delivery',
    value:
      'Orders and address or schedule changes confirmed before 8:00 PM take effect the next morning; later changes take effect the morning after.',
  },
  {
    id: 'first-delivery',
    page: 'shipping',
    label: 'When a new subscription starts',
    value:
      'A subscription paid before the 8:00 PM cut-off begins the next morning; the term start date is the first delivery date.',
  },
  {
    id: 'missed-delivery',
    page: 'shipping',
    label: 'A missed or spoiled delivery',
    value:
      'If we miss a delivery, or milk arrives spoiled and is reported the same day, that day is credited by extending the subscription term by one day — so every paid day is still delivered.',
  },
  {
    id: 'delivery-area',
    page: 'shipping',
    label: 'Serviceable area',
    value:
      'Delivery is limited to confirmed pincodes only; the pincode is checked before payment, never after. The list of serviceable pincodes is not yet confirmed.',
  },

  // ---- pause / skip / cancellation ----------------------------------------
  {
    id: 'pause-notice',
    page: 'refunds',
    label: 'Notice to pause or skip',
    value:
      'A pause or a single-day skip requested before the 8:00 PM cut-off applies from the next morning.',
  },
  {
    id: 'pause-behaviour',
    page: 'refunds',
    label: 'What a pause or skip does to the term',
    value:
      'A pause or skip does NOT forfeit the paid days. Each paused or skipped day is added back to the end of the term, so the customer still receives every day they paid for — the subscription runs later, it is not shortened. (This matches the current code in lib/subscriptions.ts.)',
  },
  {
    id: 'cancel-midterm',
    page: 'refunds',
    label: 'Cancelling a prepaid term early',
    value:
      'A customer may cancel a prepaid subscription at any time. Delivered days are charged at the standard (0%) monthly rate for the milk type; the term discount applies only to a fully completed term. The balance, if any, is refunded pro-rata to the original payment method.',
  },
  {
    id: 'refund-timeline',
    page: 'refunds',
    label: 'Refund settlement time',
    value:
      'Approved refunds are initiated within 3 business days and settle to the original payment method through Razorpay, typically within 5–7 business days depending on the bank.',
  },
  {
    id: 'quality-complaint',
    page: 'refunds',
    label: 'Raising a quality complaint',
    value:
      'A complaint about a specific delivery must be raised the same day, by phone or email, so the delivery can be verified — after which the day is credited (term extended) or, at the customer’s option, refunded pro-rata.',
  },
  {
    id: 'farm-cannot-deliver',
    page: 'refunds',
    label: 'If the farm cannot deliver',
    value:
      'If Maavuli cannot deliver for reasons on our side (weather, animal illness, a supply gap), affected days are credited by extending the term, or refunded pro-rata if the customer prefers.',
  },

  // ---- jurisdiction --------------------------------------------------------
  {
    id: 'governing-law',
    page: 'terms',
    label: 'Governing law',
    value: 'These terms are governed by the laws of India.',
  },
  {
    id: 'dispute-venue',
    page: 'terms',
    label: 'Dispute venue',
    value: 'Courts at Hyderabad, Telangana have exclusive jurisdiction over any dispute.',
  },
  {
    id: 'renewal',
    page: 'terms',
    label: 'What happens at the end of a term',
    value:
      'A prepaid term ends on its last delivery day and does not auto-renew; the customer starts a new subscription to continue. (No auto-renew mandate is set up in the current build.)',
  },
] as const;

/** The assumptions surfaced on a given policy page, plus the "all" pages. */
export function assumptionsFor(page: DraftAssumption['page']): DraftAssumption[] {
  return DRAFT_ASSUMPTIONS.filter(a => a.page === page || a.page === 'all');
}

/**
 * A single draft "last updated" marker. It is a DRAFT date, not an execution date
 * — these documents are not executed terms until the client confirms them and a
 * lawyer reviews them.
 */
export const LEGAL_DRAFT_DATE = 'Draft — not yet dated for execution';
