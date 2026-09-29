/**
 * Pure labels for the customers & finance screens (server and client safe).
 * Badge classes reuse the ops palette: is-ok / is-warn / is-bad / plain.
 */

export const PLAN_STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'is-ok' },
  scheduled: { label: 'Starts soon', tone: 'is-warn' },
  completed: { label: 'Completed', tone: '' },
  cancelled: { label: 'Cancelled', tone: 'is-bad' },
  paused: { label: 'Paused (legacy)', tone: 'is-warn' },
  none: { label: 'No plan', tone: '' },
};

export const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  created: { label: 'Unpaid', tone: 'is-warn' },
  paid: { label: 'Paid', tone: 'is-ok' },
  failed: { label: 'Payment failed', tone: 'is-bad' },
  expired: { label: 'Expired unpaid', tone: '' },
  refunded: { label: 'Refunded', tone: '' },
  partially_refunded: { label: 'Partly refunded', tone: '' },
};

export const REFUND_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Pending', tone: 'is-warn' },
  processing: { label: 'At Razorpay', tone: 'is-warn' },
  processed: { label: 'Refunded', tone: 'is-ok' },
  failed: { label: 'Failed', tone: 'is-bad' },
  awaiting_upi: { label: 'Needs UPI payout', tone: 'is-bad' },
  paid_manually: { label: 'Paid by UPI', tone: 'is-ok' },
};

export const MESSAGE_STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: 'Queued', tone: 'is-warn' },
  sent: { label: 'Sent', tone: '' },
  delivered: { label: 'Delivered', tone: 'is-ok' },
  read: { label: 'Read', tone: 'is-ok' },
  failed: { label: 'Failed', tone: 'is-bad' },
  logged: { label: 'Logged (not sent)', tone: '' },
  suppressed: { label: 'Suppressed (no opt-in)', tone: '' },
};

export const TICKET_KIND: Record<string, string> = {
  not_received: 'Milk not received',
  spoiled: 'Milk spoiled',
  quantity: 'Wrong quantity',
  other: 'Other',
};

export const CREDIT_KIND: Record<string, string> = {
  missed_delivery: 'Missed delivery',
  goodwill: 'Goodwill',
  makeup_spend: 'Spent',
  extra_spend: 'Extra bought',
  order_spend: 'Used at checkout',
  order_spend_reversal: 'Returned (order unpaid)',
  refund_payout: 'Refunded out',
  cancellation_balance: 'Cancellation balance',
  adjustment: 'Adjustment',
};

export function badge(map: Record<string, { label: string; tone: string }>, s: string): { label: string; tone: string } {
  return map[s] ?? { label: s.replace(/_/g, ' '), tone: '' };
}

/** tel: link for a 10-digit Indian mobile. */
export function telHref(mobile: string): string {
  return `tel:+91${mobile}`;
}
