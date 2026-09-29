/**
 * One-off "extra milk" orders. OWNER: B3 (money). Keep the signatures; replace the bodies.
 *
 * An extra is an add-on for a customer with an active/scheduled subscription:
 * a single delivery (source 'extra') on an open date, priced at the standard
 * 1-month rate, paid from credit first and Razorpay for the rest.
 */

import type { ObjectId } from 'mongodb';
import type { MilkKind, Order } from './models';
import type { OpCtx } from './clock';

export const EXTRA_LITRES = [0.5, 1, 1.5, 2] as const;

export interface ExtraInput {
  mobile: string;
  subscriptionId: ObjectId;
  date: string;
  kind: MilkKind;
  litres: number;
  useCredit: boolean;
  idempotencyKey: string;
}

export interface ExtraPreview {
  date: string;
  kind: MilkKind;
  litres: number;
  pricePaise: number;
  creditAvailablePaise: number;
  creditAppliedPaise: number;
  payablePaise: number;
  open: boolean;
  firstOpenDate: string;
}

export function extraPricePaise(kind: MilkKind, litres: number): number {
  void kind;
  void litres;
  throw new Error('not implemented: extraPricePaise (owner B3)');
}

export async function previewExtra(input: Omit<ExtraInput, 'idempotencyKey'>, ctx: OpCtx): Promise<ExtraPreview> {
  void input;
  void ctx;
  throw new Error('not implemented: previewExtra (owner B3)');
}

export async function createExtraOrder(
  input: ExtraInput,
  ctx: OpCtx,
): Promise<{ order: Order & { _id: ObjectId }; razorpay: { orderId: string; keyId: string; amountPaise: number } | null }> {
  void input;
  void ctx;
  throw new Error('not implemented: createExtraOrder (owner B3)');
}

/** Called by lib/orders.activateOrder for purpose 'extra': creates the delivery row. Idempotent. */
export async function activateExtraOrder(orderId: ObjectId, ctx: OpCtx): Promise<void> {
  void orderId;
  void ctx;
  throw new Error('not implemented: activateExtraOrder (owner B3)');
}
