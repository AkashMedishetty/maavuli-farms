/**
 * Delivery outcomes — the ONLY writer of delivered / not_delivered / fault.
 * Riders (via lib/rider), ops (admin resolve) and the day engine (auto-resolve)
 * all go through here, so compensation and notifications happen exactly once.
 * OWNER: B5 (rider app). Keep the signatures; replace the bodies.
 */

import type { Db, Filter, ObjectId } from 'mongodb';
import {
  col,
  REASON_FAULT,
  type Delivery,
  type DeliveryProof,
  type DeliveryStatus,
  type Fault,
  type NotDeliveredReason,
} from './models';
import type { OpCtx } from './clock';
import { getDb } from './db';
import { assertTransition, DELIVERY_TRANSITIONS } from './transitions';
import { recordEvent } from './events';
import { getOpsSettings } from './settings';
import { compensateMissedDelivery, reverseCompensation } from './compensation';
import { enqueueMessage } from './notify';
import { signedPhotoUrl } from './storage';
import { deliveredProofOk, distanceFromPinM, isDeliveryFlagged, resolveFault } from './rider-pure';
import { NotFoundError, ValidationError, ConflictError } from './errors';

/** Longest stored outcome note (SEC-8: it is shown to ops and can reach message templates). */
export const NOTE_MAX = 500;

/**
 * Filter part: no compensation claim is live on the row (lib/compensation's
 * `compensatingUntil`, a wall-clock lease like the credit lock).
 */
function notCompensating(): Filter<Delivery> {
  return { $or: [{ compensatingUntil: { $exists: false } }, { compensatingUntil: { $lt: new Date() } }] };
}

/** States a delivery may be in when it is marked. */
const DELIVERABLE_FROM: readonly DeliveryStatus[] = ['locked', 'out_for_delivery', 'unconfirmed', 'not_delivered'];
const NOT_DELIVERABLE_FROM: readonly DeliveryStatus[] = ['locked', 'out_for_delivery', 'unconfirmed', 'delivered'];

async function loadDelivery(db: Db, deliveryId: ObjectId): Promise<Delivery> {
  const d = await col.deliveries(db).findOne({ _id: deliveryId });
  if (!d) throw new NotFoundError('Delivery not found');
  return d;
}

/*
 * Compensation runs AFTER the outcome is durably written. If it fails (a DB blip, a
 * bug), the outcome must still stand — the rider's tap happened, and throwing here
 * would make the phone's offline queue record the action as rejected. The miss then
 * simply has no `resolution` yet, and the tick's compensatePendingMisses sweep
 * retries it; compensation is idempotent per delivery.
 */
async function compensateSafely(deliveryId: ObjectId, ctx: OpCtx): Promise<void> {
  try {
    await compensateMissedDelivery(deliveryId, ctx);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[outcomes] compensation deferred to the sweep', String(deliveryId), err instanceof Error ? err.message : err);
  }
}

/** Same rule for undoing a compensation (a mistaken "not delivered" corrected to delivered). */
async function reverseSafely(deliveryId: ObjectId, ctx: OpCtx): Promise<void> {
  try {
    await reverseCompensation(deliveryId, ctx);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[outcomes] compensation reversal failed', String(deliveryId), err instanceof Error ? err.message : err);
  }
}

/**
 * How far the phone's tap was from the customer's pin, in metres, or undefined when
 * either the tap location or the frozen pin is missing (nothing to measure against).
 */
function distanceFromPin(delivery: Delivery, proof: DeliveryProof): number | undefined {
  return distanceFromPinM(delivery.snapshot?.location, proof) ?? undefined;
}

/**
 * locked | out_for_delivery | unconfirmed | not_delivered → delivered.
 *
 * Proof rules (contract §4): a photo is required; if there is no photo a note must
 * be present instead and the stop is flagged. A tap further than proofDistanceFlagM
 * from the pin is also flagged. Re-marking a delivery already delivered is a no-op.
 *
 * `opts.note` is stored in the SAME conditional update as the status change, so a
 * rejected mark never leaves a stray note behind. A staff correction from the desk
 * (a phone call with the customer) is not flagged: the staff note is the proof.
 */
export async function markDelivered(
  deliveryId: ObjectId,
  proof: DeliveryProof,
  ctx: OpCtx,
  opts: { note?: string } = {},
): Promise<Delivery> {
  const db = await getDb();
  const delivery = await loadDelivery(db, deliveryId);

  // Idempotent: re-marking the same outcome is a no-op, returns the current row.
  if (delivery.status === 'delivered') return delivery;

  if (!DELIVERABLE_FROM.includes(delivery.status)) {
    assertTransition('delivery', DELIVERY_TRANSITIONS, delivery.status, 'delivered');
  }

  const settings = await getOpsSettings(db);
  const distance = distanceFromPin(delivery, proof);
  const hasPhoto = typeof proof.photoKey === 'string' && proof.photoKey.length > 0;
  const newNote = opts.note?.trim() ? opts.note.trim().slice(0, 500) : undefined;
  const note = newNote ?? delivery.note;

  // No camera → the rider must type a note, and the stop is flagged.
  if (!deliveredProofOk(hasPhoto, note)) {
    throw new ValidationError('A photo or a note is required to mark this delivery as done.');
  }

  const flagged =
    ctx.actor.kind !== 'staff' &&
    isDeliveryFlagged({
      hasPhoto,
      distanceM: distance ?? null,
    flagThresholdM: settings.proofDistanceFlagM,
  });

  const proofToStore: DeliveryProof = {
    ...(proof.photoKey ? { photoKey: proof.photoKey } : {}),
    ...(typeof proof.lat === 'number' ? { lat: proof.lat } : {}),
    ...(typeof proof.lng === 'number' ? { lng: proof.lng } : {}),
    ...(typeof proof.accuracyM === 'number' ? { accuracyM: proof.accuracyM } : {}),
    ...(typeof distance === 'number' ? { distanceFromPinM: distance } : {}),
    capturedAt: proof.capturedAt ?? ctx.now,
    ...(flagged ? { flagged: true } : {}),
  };

  // Conditional update matching the FROM state — two concurrent writers cannot both win.
  // Not while a compensation for this row is being written: it would land its
  // make-up day / credit on a row that is now delivered, after we looked for one.
  const res = await col.deliveries(db).updateOne(
    { _id: deliveryId, status: delivery.status, ...notCompensating() },
    {
      $set: {
        status: 'delivered',
        deliveredAt: ctx.now,
        proof: proofToStore,
        updatedAt: ctx.now,
        ...(newNote ? { note: newNote } : {}),
      },
    },
  );
  if (res.matchedCount === 0) {
    throw new ConflictError('This delivery was updated by someone else — reload and try again.');
  }

  await recordEvent(
    ctx,
    {
      entity: 'delivery',
      entityId: String(deliveryId),
      type: 'delivery.delivered',
      from: delivery.status,
      to: 'delivered',
      mobile: delivery.mobile,
      data: {
        flagged,
        ...(typeof distance === 'number' ? { distanceFromPinM: distance } : {}),
        hasPhoto,
      },
    },
    db,
  );

  let updated = await loadDelivery(db, deliveryId);

  // A "not delivered" corrected to delivered: undo its make-up day / credit. Read the
  // resolution AFTER our write — a compensation that finished between our first read
  // and the write is visible only now.
  if (delivery.status === 'not_delivered' && updated.resolution && updated.resolution !== 'none') {
    await reverseSafely(deliveryId, ctx);
    updated = await loadDelivery(db, deliveryId);
  }

  // delivered_today notice, only for customers who opted into the daily photo.
  const user = await col.users(db).findOne({ mobile: delivery.mobile });
  if (user?.notifyDailyDelivered) {
    const time = ctx.now.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
    });
    let mediaUrl: string | undefined;
    if (proofToStore.photoKey) {
      try {
        mediaUrl = await signedPhotoUrl(proofToStore.photoKey, 24 * 3600);
      } catch {
        // A missing NEXT_PUBLIC_SITE_URL must not fail the delivery — send text-only.
        mediaUrl = undefined;
      }
    }
    await enqueueMessage(
      {
        mobile: delivery.mobile,
        template: 'delivered_today',
        params: { time },
        dedupeKey: `delivered:${String(deliveryId)}`,
        ...(mediaUrl ? { mediaUrl } : {}),
      },
      ctx,
    );
  }

  return updated;
}

/**
 * → not_delivered with a reason. Fault defaults from REASON_FAULT; only STAFF may
 * pass an explicit fault (a rider's fault is always the reason default). fault
 * 'ours' triggers compensation (once). Re-marking the same reason is a no-op.
 */
export async function markNotDelivered(
  deliveryId: ObjectId,
  input: { reason: NotDeliveredReason; note?: string; fault?: Fault },
  ctx: OpCtx,
): Promise<Delivery> {
  const db = await getDb();
  const delivery = await loadDelivery(db, deliveryId);

  if (typeof input.reason !== 'string' || !Object.hasOwn(REASON_FAULT, input.reason)) {
    throw new ValidationError(`Unknown reason "${input.reason}"`);
  }

  // Idempotent no-op: already not_delivered with the same reason.
  if (delivery.status === 'not_delivered' && delivery.reason === input.reason) return delivery;

  if (!NOT_DELIVERABLE_FROM.includes(delivery.status)) {
    assertTransition('delivery', DELIVERY_TRANSITIONS, delivery.status, 'not_delivered');
  }

  // Only staff may override the fault; anyone else takes the reason's default.
  const fault: Fault = resolveFault(input.reason, ctx.actor.kind, input.fault);

  const res = await col.deliveries(db).updateOne(
    { _id: deliveryId, status: delivery.status },
    {
      $set: {
        status: 'not_delivered',
        reason: input.reason,
        fault,
        updatedAt: ctx.now,
        ...(input.note?.trim() ? { reasonNote: input.note.trim().slice(0, NOTE_MAX) } : {}),
      },
    },
  );
  if (res.matchedCount === 0) {
    throw new ConflictError('This delivery was updated by someone else — reload and try again.');
  }

  await recordEvent(
    ctx,
    {
      entity: 'delivery',
      entityId: String(deliveryId),
      type: 'delivery.not_delivered',
      from: delivery.status,
      to: 'not_delivered',
      mobile: delivery.mobile,
      reason: input.reason,
      data: { fault },
    },
    db,
  );

  // fault 'ours' → compensate exactly once (B3). fault 'customer' → notify only.
  if (fault === 'ours') {
    await compensateSafely(deliveryId, ctx);
  } else if (fault === 'customer') {
    const date = delivery.date;
    await enqueueMessage(
      {
        mobile: delivery.mobile,
        template: 'not_delivered_customer',
        params: { date, reason: input.reason },
        dedupeKey: `missed_c:${String(deliveryId)}`,
      },
      ctx,
    );
  }
  // fault 'unknown' → nothing yet; ops resolves it with setFault.

  return loadDelivery(db, deliveryId);
}

/** Staff: decide the fault of a not_delivered(unknown) delivery; 'ours' → compensation. */
export async function setFault(deliveryId: ObjectId, fault: Exclude<Fault, 'unknown'>, ctx: OpCtx): Promise<Delivery> {
  if (ctx.actor.kind !== 'staff') {
    throw new ValidationError('Only staff may set the fault of a delivery.');
  }
  if (fault !== 'ours' && fault !== 'customer') {
    throw new ValidationError('Fault must be "ours" or "customer".');
  }

  const db = await getDb();
  const delivery = await loadDelivery(db, deliveryId);

  if (delivery.status !== 'not_delivered') {
    throw new ConflictError('Only a not-delivered delivery has a fault to set.', { status: delivery.status });
  }
  // Idempotent no-op.
  if (delivery.fault === fault) return delivery;

  // CAS on the fault we read too: two staff deciding at once must not both win (A
  // compensates for 'ours' while B, who read 'unknown', skips the reversal).
  const res = await col.deliveries(db).updateOne(
    {
      _id: deliveryId,
      status: 'not_delivered',
      ...(delivery.fault === undefined ? { fault: { $exists: false } } : { fault: delivery.fault }),
      ...notCompensating(),
    },
    { $set: { fault, updatedAt: ctx.now } },
  );
  if (res.matchedCount === 0) {
    throw new ConflictError('This delivery was updated by someone else — reload and try again.');
  }

  await recordEvent(
    ctx,
    {
      entity: 'delivery',
      entityId: String(deliveryId),
      type: 'delivery.fault_set',
      mobile: delivery.mobile,
      reason: delivery.reason,
      data: { from: delivery.fault ?? 'unknown', to: fault },
    },
    db,
  );

  if (fault === 'ours') {
    await compensateSafely(deliveryId, ctx);
  } else {
    // ours → customer: a compensation already given is undone first (read after our write).
    const now = await loadDelivery(db, deliveryId);
    if (delivery.fault === 'ours' && now.resolution && now.resolution !== 'none') {
      await reverseSafely(deliveryId, ctx);
    }
    await enqueueMessage(
      {
        mobile: delivery.mobile,
        template: 'not_delivered_customer',
        params: { date: delivery.date, reason: delivery.reason ?? 'other' },
        dedupeKey: `missed_c:${String(deliveryId)}`,
      },
      ctx,
    );
  }

  return loadDelivery(db, deliveryId);
}

/**
 * Staff: accept a flagged proof ("checked with the customer, it was delivered").
 * The delivery stays delivered; the flag is cleared (so it leaves the exceptions
 * queue) with who/when/why recorded on the proof and in the event log.
 */
export async function clearProofFlag(deliveryId: ObjectId, note: string, ctx: OpCtx): Promise<Delivery> {
  if (ctx.actor.kind !== 'staff') throw new ValidationError('Only staff may clear a proof flag.');
  const why = note.trim();
  if (why.length < 3 || why.length > 300) throw new ValidationError('Say why the proof is accepted (3–300 characters).');
  const db = await getDb();
  const delivery = await loadDelivery(db, deliveryId);
  if (delivery.status !== 'delivered') {
    throw new ConflictError('Only a delivered stop has a proof flag to clear.', { status: delivery.status });
  }
  if (!delivery.proof?.flagged) return delivery; // already cleared: idempotent
  const res = await col.deliveries(db).updateOne(
    { _id: deliveryId, status: 'delivered', 'proof.flagged': true },
    {
      $set: {
        'proof.flagged': false,
        'proof.flagClearedAt': ctx.now,
        'proof.flagClearedBy': ctx.actor.id,
        'proof.flagClearNote': why,
        updatedAt: ctx.now,
      },
    },
  );
  if (res.matchedCount === 1) {
    await recordEvent(
      ctx,
      { entity: 'delivery', entityId: String(deliveryId), type: 'delivery.flag_cleared', mobile: delivery.mobile, reason: why },
      db,
    );
  }
  return loadDelivery(db, deliveryId);
}
