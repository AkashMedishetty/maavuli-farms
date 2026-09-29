/**
 * Orders: checkout creation, payment state, activation dispatch, expiry.
 *
 * OWNER: B1 (subscriptions & orders). The signatures below are the contract other
 * agents code against — keep them; replace the bodies.
 */

import type { ObjectId } from 'mongodb';
import type { DeliveryDetails, MilkKind, Order } from './models';
import type { OpCtx } from './clock';

export interface CheckoutInput {
  /** always the SESSION mobile — never taken from the request body */
  mobile: string;
  purpose: 'new' | 'renewal';
  kind: MilkKind;
  quantityId: string;
  tenureId: string;
  /** requested first delivery; clamped to the first open date (renewals: day after the renewed plan ends) */
  startDate?: string;
  /** purpose 'renewal' */
  renewsSubscriptionId?: ObjectId;
  /** location REQUIRED */
  details: DeliveryDetails;
  useCredit: boolean;
  whatsappOptIn: boolean;
  /** client UUID per checkout attempt — a retry with the same key returns the same order */
  idempotencyKey: string;
}

export interface CheckoutPreview {
  amountPaise: number;
  originalPaise: number;
  savingPaise: number;
  perLitrePaise: number;
  days: number;
  litres: number;
  /** the first delivery date this order would get */
  startDate: string;
  endDate: string;
  firstOpenDate: string;
  creditAvailablePaise: number;
  creditAppliedPaise: number;
  payablePaise: number;
}

export interface CheckoutResult {
  order: Order & { _id: ObjectId };
  /** null when the order was paid entirely from credit (already paid + activated) */
  razorpay: { orderId: string; keyId: string; amountPaise: number } | null;
  preview: CheckoutPreview;
}

export async function previewCheckout(
  input: Omit<CheckoutInput, 'details' | 'whatsappOptIn' | 'idempotencyKey'>,
  ctx: OpCtx,
): Promise<CheckoutPreview> {
  void input;
  void ctx;
  throw new Error('not implemented: previewCheckout (owner B1)');
}

export async function createCheckoutOrder(input: CheckoutInput, ctx: OpCtx): Promise<CheckoutResult> {
  void input;
  void ctx;
  throw new Error('not implemented: createCheckoutOrder (owner B1)');
}

/**
 * created|failed|expired → paid, then activateOrder. Idempotent: an already-paid
 * order returns unchanged (and activation is re-run, which is itself idempotent).
 */
export async function markOrderPaid(
  orderId: ObjectId,
  payment: { razorpayPaymentId?: string; source: 'verify' | 'webhook' | 'credit' },
  ctx: OpCtx,
): Promise<Order> {
  void orderId;
  void payment;
  void ctx;
  throw new Error('not implemented: markOrderPaid (owner B1)');
}

export async function markOrderFailed(orderId: ObjectId, ctx: OpCtx): Promise<void> {
  void orderId;
  void ctx;
  throw new Error('not implemented: markOrderFailed (owner B1)');
}

/** Dispatch by purpose: new/renewal → subscription activation; extra → lib/extras.activateExtraOrder. */
export async function activateOrder(orderId: ObjectId, ctx: OpCtx): Promise<void> {
  void orderId;
  void ctx;
  throw new Error('not implemented: activateOrder (owner B1)');
}

/** Tick step: created orders older than unpaidOrderExpiryMinutes → expired (credit spends reversed). */
export async function expireUnpaidOrders(ctx: OpCtx): Promise<{ expired: number }> {
  void ctx;
  throw new Error('not implemented: expireUnpaidOrders (owner B1)');
}
