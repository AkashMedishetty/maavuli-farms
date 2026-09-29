/**
 * Allowed state transitions — PURE. The one table every writer checks against.
 *
 * A status field written without consulting this table is how "cancelled" orders
 * get paid and "delivered" milk gets un-delivered. Every module that changes a
 * status calls assertTransition() first and records a DomainEvent after.
 *
 * Import with a relative path ending in .ts from tests (scripts/verify-transitions.ts).
 */

import type { DeliveryStatus, OrderStatus, RefundStatus, RunStatus, SubStatus } from './models.ts';

type Table<S extends string> = Readonly<Record<S, readonly S[]>>;

export const ORDER_TRANSITIONS: Table<OrderStatus> = {
  created: ['paid', 'failed', 'expired'],
  // a retried payment on a failed attempt, or a late payment on an expired order,
  // still activates: money received always wins
  failed: ['paid', 'expired'],
  expired: ['paid'],
  paid: ['partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  refunded: [],
};

export const SUB_TRANSITIONS: Table<SubStatus> = {
  scheduled: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  // legacy rows only — the migration maps them to active
  paused: ['active', 'cancelled'],
};

export const DELIVERY_TRANSITIONS: Table<DeliveryStatus> = {
  planned: ['locked'],
  locked: ['out_for_delivery', 'delivered', 'not_delivered', 'unconfirmed', 'cancelled'],
  out_for_delivery: ['delivered', 'not_delivered', 'unconfirmed'],
  unconfirmed: ['delivered', 'not_delivered'],
  // a rider's own correction within the day, or ops correcting a mistaken tap
  delivered: ['not_delivered'],
  not_delivered: ['delivered'],
  cancelled: [],
  // legacy (read-only): the migration rewrites these
  scheduled: ['planned', 'locked'],
  skipped: ['not_delivered'],
  failed: ['not_delivered'],
};

export const RUN_TRANSITIONS: Table<RunStatus> = {
  planned: ['in_progress', 'closed'],
  in_progress: ['completed', 'closed'],
  completed: ['closed', 'in_progress'],
  closed: [],
};

export const REFUND_TRANSITIONS: Table<RefundStatus> = {
  pending: ['processing', 'awaiting_upi'],
  processing: ['processed', 'failed'],
  failed: ['processing', 'awaiting_upi'],
  awaiting_upi: ['paid_manually'],
  processed: [],
  paid_manually: [],
};

export class IllegalTransitionError extends Error {
  entity: string;
  from: string;
  to: string;
  constructor(entity: string, from: string, to: string) {
    super(`Illegal ${entity} transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export function canTransition<S extends string>(table: Table<S>, from: S, to: S): boolean {
  return (table[from] ?? []).includes(to);
}

/** Throws IllegalTransitionError (→ HTTP 409) unless from → to is allowed. from === to is NOT a transition. */
export function assertTransition<S extends string>(entity: string, table: Table<S>, from: S, to: S): void {
  if (!canTransition(table, from, to)) throw new IllegalTransitionError(entity, from, to);
}

/** Terminal = nothing can follow. */
export function isTerminal<S extends string>(table: Table<S>, s: S): boolean {
  return (table[s] ?? []).length === 0;
}
