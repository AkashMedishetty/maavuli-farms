/**
 * One-off "extra milk" orders. OWNER: B3 (money).
 *
 * An extra is an add-on for a customer with an active/scheduled subscription:
 * a single delivery (source 'extra') on an open date, priced at the standard
 * 1-month rate, paid from credit first and Razorpay for the rest. It is delivered to
 * that subscription's address, one extra per subscription per date.
 */

import { randomBytes } from 'node:crypto';
import type { Db, ObjectId } from 'mongodb';
import { getDb } from './db';
import { col, type MilkKind, type Order, type Subscription } from './models';
import type { OpCtx } from './clock';
import { PRODUCTS, formatINR } from './pricing';
import { addDaysYMD, isYMD } from './cutoff';
import { assertDateOpen, firstOpenDateNow, isDateLocked } from './daylock';
import { addCredit, creditBalance, reverseOrderSpend, spendLocked, withCreditLock, foldBalance } from './credits';
import { razorpayConfig } from './env';
import { createOrder } from './razorpay';
import { markOrderPaid } from './orders';
import { recordEvent } from './events';
import { enqueueMessage } from './notify';
import { ORDER_TRANSITIONS, assertTransition } from './transitions';
import { ConflictError, NotFoundError, ServiceNotConfiguredError, UpstreamError, ValidationError } from './errors';

export const EXTRA_LITRES = [0.5, 1, 1.5, 2] as const;

/** How far ahead an extra may be booked (the same horizon as a new plan's start). */
export const EXTRA_MAX_DAYS_AHEAD = 30;

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

function baseRate(kind: MilkKind): number {
  const p = PRODUCTS.find(x => x.kind === kind);
  if (!p) throw new ValidationError(`Unknown milk kind "${kind}"`);
  return p.baseRatePaise;
}

export function extraPricePaise(kind: MilkKind, litres: number): number {
  if (!(EXTRA_LITRES as readonly number[]).includes(litres)) {
    throw new ValidationError('litres must be 0.5, 1, 1.5 or 2');
  }
  // litres is a multiple of 0.5: multiply by 2 first so the arithmetic stays whole
  return (baseRate(kind) * Math.round(litres * 2)) / 2;
}

async function ownSubscription(db: Db, mobile: string, subscriptionId: ObjectId): Promise<Subscription & { _id: ObjectId }> {
  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });
  // someone else's plan is "not found", never "forbidden"
  if (!sub?._id || sub.mobile !== mobile) throw new NotFoundError('Subscription not found');
  if (sub.status !== 'active' && sub.status !== 'scheduled') {
    throw new ConflictError('Extra milk can only be added to a current plan.', { status: sub.status });
  }
  return sub as Subscription & { _id: ObjectId };
}

function validate(input: Omit<ExtraInput, 'idempotencyKey'>): void {
  const issues: string[] = [];
  if (!isYMD(input.date)) issues.push('date must be YYYY-MM-DD');
  if (input.kind !== 'cow' && input.kind !== 'buffalo') issues.push('kind must be cow or buffalo');
  if (!(EXTRA_LITRES as readonly number[]).includes(input.litres)) issues.push('litres must be 0.5, 1, 1.5 or 2');
  if (issues.length) throw new ValidationError('Invalid extra', issues);
}

export async function previewExtra(input: Omit<ExtraInput, 'idempotencyKey'>, ctx: OpCtx): Promise<ExtraPreview> {
  validate(input);
  const db = await getDb();
  await ownSubscription(db, input.mobile, input.subscriptionId);
  const firstOpenDate = await firstOpenDateNow(ctx, db);
  const pricePaise = extraPricePaise(input.kind, input.litres);
  const { balancePaise } = await creditBalance(input.mobile);
  const creditAppliedPaise = input.useCredit ? Math.min(balancePaise, pricePaise) : 0;
  const open =
    input.date >= firstOpenDate &&
    input.date <= addDaysYMD(firstOpenDate, EXTRA_MAX_DAYS_AHEAD) &&
    !(await isDateLocked(input.date, ctx, db));
  return {
    date: input.date,
    kind: input.kind,
    litres: input.litres,
    pricePaise,
    creditAvailablePaise: balancePaise,
    creditAppliedPaise,
    payablePaise: pricePaise - creditAppliedPaise,
    open,
    firstOpenDate,
  };
}

type CreatedExtra = { order: Order & { _id: ObjectId }; razorpay: { orderId: string; keyId: string; amountPaise: number } | null };

function checkoutFor(order: Order & { _id: ObjectId }): CreatedExtra['razorpay'] {
  if (order.status !== 'created' || (order.payablePaise ?? 0) <= 0 || order.razorpayOrderId.startsWith('credit_')) return null;
  const cfg = razorpayConfig();
  if (!cfg.ok) throw new ServiceNotConfiguredError('Razorpay', cfg.missing);
  return { orderId: order.razorpayOrderId, keyId: cfg.value.RAZORPAY_KEY_ID, amountPaise: order.payablePaise ?? order.amountPaise };
}

export async function createExtraOrder(input: ExtraInput, ctx: OpCtx): Promise<CreatedExtra> {
  validate(input);
  const key = input.idempotencyKey.trim();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new ValidationError('idempotencyKey must be 8–100 letters, digits, - or _');
  const db = await getDb();

  const replay = await col.orders(db).findOne({ idempotencyKey: key });
  if (replay?._id) {
    if (replay.mobile !== input.mobile || replay.purpose !== 'extra') throw new ConflictError('That checkout key was already used.');
    let o = replay as Order & { _id: ObjectId };
    // A paid order whose activation failed (credit-only checkouts have no verify or
    // webhook to retry it): the replay finishes it. Activation is idempotent.
    if (o.status === 'paid') {
      await activateExtraOrder(o._id, ctx);
      o = ((await col.orders(db).findOne({ _id: o._id })) as (Order & { _id: ObjectId }) | null) ?? o;
    }
    return { order: o, razorpay: checkoutFor(o) };
  }

  const sub = await ownSubscription(db, input.mobile, input.subscriptionId);
  await assertDateOpen(input.date, ctx, db);
  const firstOpen = await firstOpenDateNow(ctx, db);
  if (input.date > addDaysYMD(firstOpen, EXTRA_MAX_DAYS_AHEAD)) {
    throw new ValidationError(`Extra milk can be booked up to ${EXTRA_MAX_DAYS_AHEAD} days ahead.`);
  }
  const pricePaise = extraPricePaise(input.kind, input.litres);
  const cfg = razorpayConfig();

  // Decide the credit share, write the order and debit the credit under ONE lease so
  // a concurrent spend cannot leave this order claiming credit that was used elsewhere.
  // The one-extra-per-day check runs under the same lease: two tabs (or a retry with
  // a fresh key) serialise here, so the second sees the first order and is refused
  // BEFORE anyone pays for it.
  let reused = false;
  const order = await withCreditLock(input.mobile, async ldb => {
    const won = await col.orders(ldb).findOne({ idempotencyKey: key });
    if (won?._id) {
      if (won.mobile !== input.mobile || won.purpose !== 'extra') throw new ConflictError('That checkout key was already used.');
      reused = true;
      return won as Order & { _id: ObjectId };
    }
    const clash =
      (await col.deliveries(ldb).countDocuments({ subscriptionId: sub._id, date: input.date, source: 'extra' }, { limit: 1 })) > 0 ||
      (await col.orders(ldb).countDocuments(
        { purpose: 'extra', 'extra.subscriptionId': sub._id, 'extra.date': input.date, status: { $in: ['created', 'paid'] } },
        { limit: 1 },
      )) > 0;
    if (clash) throw new ConflictError('There is already extra milk booked for that day.', { date: input.date });
    const { balancePaise } = foldBalance(await col.credits(ldb).find({ mobile: input.mobile }).toArray());
    const creditAppliedPaise = input.useCredit ? Math.min(balancePaise, pricePaise) : 0;
    const payablePaise = pricePaise - creditAppliedPaise;
    if (payablePaise > 0 && !cfg.ok) throw new ServiceNotConfiguredError('Razorpay', cfg.missing);
    const hex = randomBytes(12).toString('hex');
    const doc: Order = {
      // credit-only orders never reach Razorpay; a pending id keeps the unique index
      // honest until the real Razorpay order id is written below
      razorpayOrderId: payablePaise === 0 ? `credit_${hex}` : `pending_${hex}`,
      mobile: input.mobile,
      purpose: 'extra',
      kind: input.kind,
      quantityId: 'extra',
      tenureId: 'extra',
      amountPaise: pricePaise,
      perLitrePaise: baseRate(input.kind),
      days: 1,
      litres: input.litres,
      pincode: sub.pincode,
      creditAppliedPaise,
      payablePaise,
      idempotencyKey: key,
      extra: { date: input.date, kind: input.kind, litres: input.litres, subscriptionId: sub._id },
      ...(sub.name ? { name: sub.name } : {}),
      ...(sub.address ? { address: sub.address } : {}),
      ...(sub.landmark ? { landmark: sub.landmark } : {}),
      ...(sub.instructions ? { instructions: sub.instructions } : {}),
      ...(sub.location ? { location: { lat: sub.location.lat, lng: sub.location.lng } } : {}),
      ...(sub.addressParts ? { addressParts: sub.addressParts } : {}),
      status: 'created',
      createdAt: ctx.now,
    };
    let id: ObjectId;
    try {
      id = (await col.orders(ldb).insertOne(doc)).insertedId;
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
        const w = await col.orders(ldb).findOne({ idempotencyKey: key });
        if (w?._id) {
          reused = true;
          return w as Order & { _id: ObjectId };
        }
      }
      throw err;
    }
    if (creditAppliedPaise > 0) {
      await spendLocked(ldb, input.mobile, creditAppliedPaise, 'extra_spend', { orderId: id, subscriptionId: sub._id, note: `Extra milk on ${input.date}` }, ctx);
    }
    await recordEvent(ctx, {
      entity: 'order',
      entityId: id.toHexString(),
      type: 'order.created',
      to: 'created',
      mobile: input.mobile,
      data: { purpose: 'extra', date: input.date, amountPaise: pricePaise, creditAppliedPaise },
    }, ldb);
    return { ...doc, _id: id };
  });

  // A concurrent submit with the same key won: answer with its order, never start a
  // second payment for it.
  if (reused) return { order, razorpay: checkoutFor(order) };

  if ((order.payablePaise ?? 0) === 0) {
    try {
      const paid = await markOrderPaid(order._id, { source: 'credit' }, ctx);
      return { order: { ...order, ...paid, _id: order._id }, razorpay: null };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[extras] credit-only activation failed', order._id.toHexString(), err instanceof Error ? err.message : err);
      throw err;
    }
  }

  try {
    const rz = await createOrder({
      amountPaise: order.payablePaise ?? pricePaise,
      receipt: `extra_${order._id.toHexString()}`,
      notes: { orderId: order._id.toHexString(), purpose: 'extra' },
    });
    await col.orders(db).updateOne({ _id: order._id, status: 'created' }, { $set: { razorpayOrderId: rz.id } });
    const saved = { ...order, razorpayOrderId: rz.id };
    return { order: saved, razorpay: checkoutFor(saved) };
  } catch (err) {
    // No Razorpay order means nobody can pay this one: fail it and return the credit.
    assertTransition('order', ORDER_TRANSITIONS, 'created', 'failed');
    const res = await col.orders(db).updateOne({ _id: order._id, status: 'created' }, { $set: { status: 'failed', failedAt: ctx.now } });
    if (res.matchedCount === 1) {
      await recordEvent(ctx, { entity: 'order', entityId: order._id.toHexString(), type: 'order.failed', from: 'created', to: 'failed', mobile: order.mobile, reason: 'razorpay order not created' }, db);
    }
    await reverseOrderSpend(order._id, ctx);
    if (err instanceof ServiceNotConfiguredError) throw err;
    throw new UpstreamError('Razorpay', 'Payment could not be started. Please try again.');
  }
}

/**
 * Credit the extra's price back when it can no longer be delivered. Idempotent per
 * share. Only the share paid with MONEY becomes refundable credit; the share paid
 * from credit comes back as the non-refundable credit it was.
 */
async function creditLateExtra(db: Db, order: Order & { _id: ObjectId }, why: string, ctx: OpCtx): Promise<void> {
  const payable = Math.max(0, Math.min(order.amountPaise, order.payablePaise ?? order.amountPaise - (order.creditAppliedPaise ?? 0)));
  const shares: { amountPaise: number; refundable: boolean }[] = [
    { amountPaise: payable, refundable: true },
    { amountPaise: order.amountPaise - payable, refundable: false },
  ];
  let added = false;
  for (const sh of shares) {
    if (sh.amountPaise <= 0) continue;
    const have = await col
      .credits(db)
      .countDocuments({ orderId: order._id, kind: 'adjustment', amountPaise: { $gt: 0 }, refundable: sh.refundable }, { limit: 1 });
    if (have) continue;
    await addCredit(
      {
        mobile: order.mobile,
        amountPaise: sh.amountPaise,
        kind: 'adjustment',
        refundable: sh.refundable,
        orderId: order._id,
        ...(order.extra ? { subscriptionId: order.extra.subscriptionId } : {}),
        note: `Extra milk for ${order.extra?.date ?? '?'} could not be scheduled (${why}) — ${sh.refundable ? 'price' : 'credit used'} returned`,
      },
      ctx,
    );
    added = true;
  }
  if (!added) return;
  await recordEvent(ctx, { entity: 'order', entityId: order._id.toHexString(), type: 'order.extra_credited', mobile: order.mobile, reason: why }, db);
  await enqueueMessage(
    {
      mobile: order.mobile,
      template: 'not_delivered_ours',
      params: { date: order.extra?.date ?? '', resolution: `${formatINR(order.amountPaise)} added to your Maavuli credit` },
      dedupeKey: `extra_late:${order._id.toHexString()}`,
    },
    ctx,
  );
}

/** Called by lib/orders.activateOrder for purpose 'extra': creates the delivery row. Idempotent. */
export async function activateExtraOrder(orderId: ObjectId, ctx: OpCtx): Promise<void> {
  const db = await getDb();
  const order = (await col.orders(db).findOne({ _id: orderId })) as (Order & { _id: ObjectId }) | null;
  if (!order) throw new NotFoundError('Order not found');
  if (order.purpose !== 'extra' || !order.extra) throw new ConflictError('Not an extra-milk order.');
  if (order.status !== 'paid') throw new ConflictError(`Order is ${order.status}, not paid.`);
  const { date, kind, litres, subscriptionId } = order.extra;

  const existing = await col.deliveries(db).findOne({ subscriptionId, date, source: 'extra' });
  if (existing) {
    // Another paid extra already holds this day (one extra per plan per date): this
    // one can never be delivered, so its money comes back instead of vanishing.
    if (!existing.orderId?.equals(orderId)) return creditLateExtra(db, order, 'another extra is already booked for that day', ctx);
    return;
  }
  if ((await col.credits(db).countDocuments({ orderId, kind: 'adjustment', amountPaise: { $gt: 0 } }, { limit: 1 })) > 0) return;

  const sub = await col.subscriptions(db).findOne({ _id: subscriptionId });
  if (!sub || (sub.status !== 'active' && sub.status !== 'scheduled')) {
    return creditLateExtra(db, order, 'the plan is no longer active', ctx);
  }
  // Payment can land after the cutoff (a slow UPI, a late webhook): that day's
  // manifest is frozen, so the milk cannot go out — the customer gets the money back
  // as refundable credit instead of a delivery that silently never happens.
  if (await isDateLocked(date, ctx, db)) return creditLateExtra(db, order, 'payment arrived after the cutoff', ctx);

  let deliveryId: ObjectId | undefined;
  try {
    deliveryId = (
      await col.deliveries(db).insertOne({
        subscriptionId,
        mobile: order.mobile,
        date,
        kind,
        litres,
        pincode: sub.pincode,
        status: 'planned',
        source: 'extra',
        orderId,
        updatedAt: ctx.now,
        ...(sub.stopKey ? { stopKey: sub.stopKey } : {}),
      })
    ).insertedId;
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      const holder = await col.deliveries(db).findOne({ subscriptionId, date, source: 'extra' });
      if (holder && !holder.orderId?.equals(orderId)) return creditLateExtra(db, order, 'another extra is already booked for that day', ctx);
      return;
    }
    throw err;
  }
  // The lock could have run between the check and the insert.
  if (await isDateLocked(date, ctx, db)) {
    const del = await col.deliveries(db).deleteOne({ _id: deliveryId, status: 'planned' });
    if (del.deletedCount === 1) return creditLateExtra(db, order, 'payment arrived after the cutoff', ctx);
  }
  await recordEvent(ctx, {
    entity: 'delivery',
    entityId: deliveryId.toHexString(),
    type: 'delivery.planned',
    to: 'planned',
    mobile: order.mobile,
    data: { source: 'extra', date, orderId: orderId.toHexString() },
  }, db);
  await enqueueMessage(
    {
      mobile: order.mobile,
      template: 'extra_confirmed',
      params: { date, litres: String(litres), kind },
      dedupeKey: `extra:${orderId.toHexString()}`,
    },
    ctx,
  );
}
