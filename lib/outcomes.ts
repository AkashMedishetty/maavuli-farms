/**
 * Delivery outcomes — the ONLY writer of delivered / not_delivered / fault.
 * Riders (via lib/rider), ops (admin resolve) and the day engine (auto-resolve)
 * all go through here, so compensation and notifications happen exactly once.
 * OWNER: B5 (rider app). Keep the signatures; replace the bodies.
 */

import type { ObjectId } from 'mongodb';
import type { Delivery, DeliveryProof, Fault, NotDeliveredReason } from './models';
import type { OpCtx } from './clock';

/** locked | out_for_delivery | unconfirmed | not_delivered → delivered. Flags proof far from the pin. */
export async function markDelivered(deliveryId: ObjectId, proof: DeliveryProof, ctx: OpCtx): Promise<Delivery> {
  void deliveryId;
  void proof;
  void ctx;
  throw new Error('not implemented: markDelivered (owner B5)');
}

/**
 * → not_delivered with a reason; fault defaults from REASON_FAULT (models.ts) and
 * only staff may pass an explicit fault. fault 'ours' → lib/compensation.
 */
export async function markNotDelivered(
  deliveryId: ObjectId,
  input: { reason: NotDeliveredReason; note?: string; fault?: Fault },
  ctx: OpCtx,
): Promise<Delivery> {
  void deliveryId;
  void input;
  void ctx;
  throw new Error('not implemented: markNotDelivered (owner B5)');
}

/** Staff: decide the fault of a not_delivered(unknown) delivery; 'ours' → compensation. */
export async function setFault(deliveryId: ObjectId, fault: Exclude<Fault, 'unknown'>, ctx: OpCtx): Promise<Delivery> {
  void deliveryId;
  void fault;
  void ctx;
  throw new Error('not implemented: setFault (owner B5)');
}
