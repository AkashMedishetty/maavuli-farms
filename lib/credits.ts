/**
 * Credit ledger (immutable entries; balance = sum). OWNER: B3 (money).
 * Keep the signatures; replace the bodies.
 */

import type { ObjectId } from 'mongodb';
import type { CreditEntry } from './models';
import type { OpCtx } from './clock';

export interface CreditBalance {
  balancePaise: number;
  /** portion of the balance that came from paid-but-missed days (returned at cancellation) */
  refundablePaise: number;
}

export async function creditBalance(mobile: string): Promise<CreditBalance> {
  void mobile;
  throw new Error('not implemented: creditBalance (owner B3)');
}

export async function creditHistory(mobile: string, limit?: number): Promise<CreditEntry[]> {
  void mobile;
  void limit;
  throw new Error('not implemented: creditHistory (owner B3)');
}

/** Positive entry. Writes a DomainEvent. */
export async function addCredit(
  entry: Omit<CreditEntry, '_id' | 'at' | 'actor'> & { amountPaise: number },
  ctx: OpCtx,
): Promise<CreditEntry> {
  void entry;
  void ctx;
  throw new Error('not implemented: addCredit (owner B3)');
}

/** Negative entry of `amountPaise` (> 0). Throws ConflictError when the balance is insufficient. */
export async function spendCredit(
  mobile: string,
  amountPaise: number,
  kind: 'makeup_spend' | 'extra_spend' | 'order_spend' | 'refund_payout' | 'adjustment',
  refs: { orderId?: ObjectId; subscriptionId?: ObjectId; deliveryId?: ObjectId; refundId?: ObjectId; note?: string },
  ctx: OpCtx,
): Promise<CreditEntry> {
  void mobile;
  void amountPaise;
  void kind;
  void refs;
  void ctx;
  throw new Error('not implemented: spendCredit (owner B3)');
}

/** Undo an order's credit spend (order expired / failed permanently). Idempotent per order. */
export async function reverseOrderSpend(orderId: ObjectId, ctx: OpCtx): Promise<void> {
  void orderId;
  void ctx;
  throw new Error('not implemented: reverseOrderSpend (owner B3)');
}
