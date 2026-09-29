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
 *     (BRAND, CONTACT, LEGAL_ENTITY — the firm registration and FSSAI licence come
 *     from its certificates). It is never restated here as if it were our decision.
 *   - Facts we do NOT have (the serviceable pincode list, the grievance officer's
 *     name) are absent here on purpose and render as pending states. They are
 *     never given a placeholder value.
 *
 * When the client confirms a value, move it out of here into a plain statement and
 * drop it from the "To confirm" block.
 */

import { DEFAULT_DAY_RULES, hmLabel, type DayRules } from './cutoff';

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
    value: 'Between {windowStart} and {windowEnd}, every morning including weekends.',
  },
  {
    id: 'order-cutoff',
    page: 'shipping',
    label: 'Cut-off for the next morning',
    value:
      'Changes for a delivery day — a pause, a resumed day, extra milk, a cancellation, an address change — close at {cutoff} the day before. After that the day’s route is fixed and the change applies from the next open day.',
  },
  {
    id: 'first-delivery',
    page: 'shipping',
    label: 'When a new subscription starts',
    value:
      'The first delivery is on the start date you choose (up to 30 days ahead), or the earliest day still open under the {cutoff} cut-off if that is later. The term runs from the first delivery.',
  },
  {
    id: 'missed-delivery',
    page: 'shipping',
    label: 'A delivery we miss',
    value:
      'If we miss a delivery for a reason on our side, one day is added to the end of your plan. You can instead choose, in your account, to receive that day’s value as Maavuli credit, at the price you paid. Credit from missed days that you have not spent is refunded if you cancel.',
  },
  {
    id: 'proof-of-delivery',
    page: 'shipping',
    label: 'Proof of delivery',
    value:
      'The delivery partner takes a photo at your door and records the phone’s location when marking a delivery done. You can see that photo in your account.',
  },
  {
    id: 'delivery-area',
    page: 'shipping',
    label: 'Serviceable area',
    value:
      'Delivery is limited to the areas we serve; your door’s map pin is checked against them before payment, never after. The list of delivery areas is not yet confirmed for publication.',
  },

  // ---- pause / skip / cancellation ----------------------------------------
  {
    id: 'pause-notice',
    page: 'refunds',
    label: 'Notice to pause or skip',
    value:
      'A pause or a single-day skip made before the {cutoff} cut-off applies from the next morning; later, from the day after.',
  },
  {
    id: 'pause-behaviour',
    page: 'refunds',
    label: 'What a pause or skip does to the term',
    value:
      'Each plan includes a set number of pause days. A pause or skip within them does NOT forfeit the paid days: each paused or skipped day is added back to the end of the term, so the customer still receives every day they paid for — the subscription runs later, it is not shortened. Once the pause days are used up, further days cannot be paused.',
  },
  {
    id: 'cancel-midterm',
    page: 'refunds',
    label: 'Cancelling a prepaid term early',
    value:
      'A customer may cancel at any time; deliveries stop from the next open day. Every day already delivered or already on the route is charged at the standard (0%) 1-month rate for the milk type and quantity; the term discount applies only to a completed term. Refund = amount paid − (charged days × standard daily rate), never below zero, plus any unspent credit from days we missed. Example: 1 L cow for a year costs ₹35,190; cancelled after 60 charged days, 60 × ₹115 = ₹6,900 is charged and ₹28,290 is refunded. The refund reaches ₹0 at day 306.',
  },
  {
    id: 'refund-destination',
    page: 'refunds',
    label: 'Where a refund goes',
    value:
      'The refund goes back to the original payment through Razorpay, up to the amount actually paid by card/UPI. Any part of the plan that was paid with Maavuli credit is returned as Maavuli credit.',
  },
  {
    id: 'refund-old-payment',
    page: 'refunds',
    label: 'Payments older than 6 months',
    value:
      'Razorpay cannot refund a payment more than 6 months old. In that case we ask you for a UPI id and send the refund by UPI transfer instead, and tell you the transaction reference once it is paid.',
  },
  {
    id: 'refund-timeline',
    page: 'refunds',
    label: 'Refund settlement time',
    value:
      'Approved refunds are initiated within 3 business days and settle to the original payment method through Razorpay, typically within 5–7 business days depending on the bank.',
  },
  {
    id: 'missed-day-choice',
    page: 'refunds',
    label: 'A day we miss: extra day or credit',
    value:
      'When we miss a delivery for a reason on our side, the default is one day added to the end of your plan. At your choice (set in your account) you get that day’s value as Maavuli credit instead, at the price you paid. Unspent credit from missed days is refunded when you cancel; goodwill credit is not.',
  },
  {
    id: 'quality-complaint',
    page: 'refunds',
    label: 'Raising a quality complaint',
    value:
      'A complaint about a specific delivery must be raised the same day, by phone or email, so the delivery can be verified — after which it is treated as a day we missed (a day added, or credit at your choice).',
  },
  {
    id: 'farm-cannot-deliver',
    page: 'refunds',
    label: 'If the farm cannot deliver',
    value:
      'If Maavuli cannot deliver for reasons on our side (weather, animal illness, a supply gap), each affected day is treated as a day we missed: a day added to your plan, or credit at your choice.',
  },
  {
    id: 'customer-miss',
    page: 'refunds',
    label: 'A delivery missed for a reason on your side',
    value:
      'If a delivery cannot be made for a reason on your side — the delivery partner cannot get to your door, the milk is refused, or you ask on the day for it to be skipped after the cut-off — the day counts as delivered: it is not added back, and it counts as charged if you later cancel.',
  },

  // ---- privacy ---------------------------------------------------------------
  {
    id: 'whatsapp',
    page: 'privacy',
    label: 'WhatsApp messages',
    value:
      'Sign-in codes are sent to your mobile on WhatsApp when you ask for one. Updates about your orders, deliveries, pauses and refunds are sent only if you opt in, and the daily delivery photo only if you also turn it on. The messages are carried by Meta (WhatsApp), which processes them under its own terms. You can turn updates off in your account, or reply STOP, at any time.',
  },
  {
    id: 'location-pin',
    page: 'privacy',
    label: 'Your exact location pin',
    value:
      'We store the exact map pin of your door to route deliveries. The delivery partner assigned to your area sees it, with your name, address, delivery notes and phone number (so they can call you at the door), on the days they deliver to you.',
  },
  {
    id: 'doorstep-photos',
    page: 'privacy',
    label: 'Doorstep photos',
    value:
      'Each delivery is photographed at your door as proof. The photo is private: it is visible to you, to Maavuli staff, and to the delivery partner who took it on that day. Photos are deleted after {photoDays} days.',
  },

  // ---- the agreement -------------------------------------------------------
  {
    id: 'account',
    page: 'terms',
    label: 'Your account',
    value:
      'You sign in with a one-time code sent to your mobile number, so anyone who can read your messages can sign in as you. Keep your phone secure, and keep your address, pin and delivery notes accurate: deliveries follow them.',
  },
  {
    id: 'credit',
    page: 'terms',
    label: 'Maavuli credit',
    value:
      'Credit in your account comes from days we missed, from extra milk we could not deliver, from the balance of a cancelled plan that was paid with credit, or as goodwill from our team. It is used towards a new plan, a renewal or extra milk, and cannot otherwise be withdrawn as money — except that unspent credit from days we missed on a plan is refunded when you cancel it, as the Refund & Cancellation Policy sets out.',
  },
  {
    id: 'extra-milk',
    page: 'terms',
    label: 'Extra milk',
    value:
      'Extra milk can be booked for any day still open for changes, up to 30 days ahead, and is paid in advance. If the payment reaches us after that day’s {cutoff} cut-off, or the day can no longer be delivered, its price comes back to you as Maavuli credit.',
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

/** Photo retention when no live setting is passed (lib/settings DEFAULT_OPS). */
const DEFAULT_PHOTO_DAYS = 60;

/**
 * The assumptions surfaced on a given policy page, plus the "all" pages.
 *
 * Times in the texts are TOKENS ({cutoff}, {windowStart}, {windowEnd}) filled from
 * the live ops settings, because ops can change the cut-off and the delivery window
 * in admin — a policy page that kept saying "4:00 PM" after the cut-off moved would
 * promise customers something the platform no longer does. {photoDays} is the live
 * photo-retention setting, for the same reason.
 */
export function assumptionsFor(
  page: DraftAssumption['page'],
  rules: DayRules = DEFAULT_DAY_RULES,
  opts: { photoRetentionDays?: number } = {},
): DraftAssumption[] {
  const fill = (s: string) =>
    s
      .replaceAll('{cutoff}', hmLabel(rules.cutoffTime))
      .replaceAll('{windowStart}', hmLabel(rules.windowStart))
      .replaceAll('{windowEnd}', hmLabel(rules.windowEnd))
      .replaceAll('{photoDays}', String(opts.photoRetentionDays ?? DEFAULT_PHOTO_DAYS));
  return DRAFT_ASSUMPTIONS.filter(a => a.page === page || a.page === 'all').map(a => ({
    ...a,
    label: fill(a.label),
    value: fill(a.value),
  }));
}

/**
 * A single draft "last updated" marker. It is a DRAFT date, not an execution date
 * — these documents are not executed terms until the client confirms them and a
 * lawyer reviews them.
 */
export const LEGAL_DRAFT_DATE = 'Draft — not yet dated for execution';
