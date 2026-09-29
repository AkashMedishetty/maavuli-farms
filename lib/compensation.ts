/**
 * Making good a delivery WE missed. OWNER: B3 (money).
 *
 * Rule: a not_delivered delivery with fault 'ours' is compensated exactly once —
 *  · customer preference 'makeup_day' (default) and the subscription can still be
 *    extended → one make-up day appended (lib/subscriptions.extendSubscription,
 *    source 'makeup'); resolution 'makeup_day'
 *  · otherwise → a refundable credit worth that day's milk at the price PAID
 *    (order.perLitrePaise x litres); resolution 'credit'
 * Extras (source 'extra') are always compensated as credit of their price.
 *
 * Exactly-once: `delivery.resolution` is the durable marker. While a compensation is
 * being applied the row carries a short claim (`compensatingUntil`, wall-clock) so
 * two concurrent callers (rider tap + the tick sweep) cannot both append a day. The
 * credit path is additionally keyed on the ledger (one missed_delivery row per
 * delivery), so even a crash between the credit and the resolution write cannot pay
 * twice. The make-up path writes `makeupPendingFrom` (the plan's endDate) before
 * extending, so a retry after a crash between extend and the resolution write adopts
 * the day already appended instead of appending a second one.
 */

import type { Db, Filter, ObjectId, UpdateFilter } from 'mongodb';
import { getDb } from './db';
import { col, type Delivery, type Subscription } from './models';
import type { OpCtx } from './clock';
import { addCredit, spendLocked, withCreditLock, foldBalance } from './credits';
import { extendSubscription, addDays } from './subscriptions';
import { firstOpenDateNow, isDateLocked } from './daylock';
import { recordEvent } from './events';
import { enqueueMessage } from './notify';
import { formatINR } from './pricing';
import { ConflictError, NotFoundError } from './errors';
import { standardDailyPaise } from './refunds';

const CLAIM_MS = 60_000;

type Resolution = 'makeup_day' | 'credit' | 'none';

/** Take the per-delivery claim. `extra` narrows the filter (e.g. resolution must be absent). */
async function claim(db: Db, deliveryId: ObjectId, extra: Filter<Delivery>): Promise<boolean> {
  const wall = new Date();
  const res = await col.deliveries(db).updateOne(
    {
      _id: deliveryId,
      ...extra,
      $or: [{ compensatingUntil: { $exists: false } }, { compensatingUntil: { $lt: wall } }],
    } as Filter<Delivery>,
    { $set: { compensatingUntil: new Date(wall.getTime() + CLAIM_MS) } } as UpdateFilter<Delivery>,
  );
  return res.matchedCount === 1;
}

async function release(db: Db, deliveryId: ObjectId): Promise<void> {
  await col.deliveries(db).updateOne({ _id: deliveryId }, { $unset: { compensatingUntil: '' } } as UpdateFilter<Delivery>);
}

async function canExtend(db: Db, sub: Subscription, ctx: OpCtx): Promise<boolean> {
  if (sub.status !== 'active' && sub.status !== 'scheduled') return false;
  // An appended day that is already past its cutoff would never reach a manifest.
  return addDays(sub.endDate, 1) >= (await firstOpenDateNow(ctx, db));
}

/** The value of the missed day. `refundable` is money the customer paid; `credit` is the share they paid from credit. */
async function missedValuePaise(db: Db, d: Delivery, sub: Subscription): Promise<{ refundable: number; credit: number }> {
  if (d.source === 'extra') {
    const o = d.orderId ? await col.orders(db).findOne({ _id: d.orderId }) : null;
    if (!o) throw new Error(`compensation: extra order for delivery ${String(d._id)} not found`);
    // Only the money share becomes refundable; the credit-paid share comes back as
    // the non-refundable credit it was (else goodwill credit turns into card money).
    const payable = Math.max(0, Math.min(o.amountPaise, o.payablePaise ?? o.amountPaise - (o.creditAppliedPaise ?? 0)));
    return { refundable: payable, credit: o.amountPaise - payable };
  }
  // A day of a CANCELLED plan dated before it stopped was already charged at the
  // standard daily rate by the cancellation refund — make it good at that rate.
  if (sub.status === 'cancelled' && sub.cancelEffectiveDate && d.date < sub.cancelEffectiveDate) {
    return { refundable: standardDailyPaise(sub.kind, sub.qtyNum, sub.qtyDen), credit: 0 };
  }
  const o = await col.orders(db).findOne({ _id: sub.orderId });
  if (!o) throw new Error(`compensation: order for subscription ${String(sub._id)} not found`);
  return { refundable: Math.round(o.perLitrePaise * d.litres), credit: 0 };
}

/**
 * What this delivery's missed-day credit is still worth to the customer, per share:
 * credited (missed_delivery rows) minus reversed (adjustment debits). Net-based, so a
 * compensation after a reversal adds new credit, and a retry after a crash adds none.
 * Reversals: the refundable share is tagged with the deliveryId (the ledger counts
 * it as refundable-out); the credit share with the extra's orderId and no deliveryId.
 */
async function netCredit(db: Db, d: Delivery & { _id: ObjectId }): Promise<{ refundable: number; credit: number; lastId?: ObjectId }> {
  const ins = await col.credits(db).find({ deliveryId: d._id, kind: 'missed_delivery' }).sort({ at: 1, _id: 1 }).toArray();
  const outR = await col.credits(db).find({ deliveryId: d._id, kind: 'adjustment', amountPaise: { $lt: 0 } }).toArray();
  const outN = d.orderId
    ? await col.credits(db).find({ orderId: d.orderId, deliveryId: { $exists: false }, kind: 'adjustment', amountPaise: { $lt: 0 } }).toArray()
    : [];
  const sum = (rows: { amountPaise: number }[]) => rows.reduce((s, r) => s + r.amountPaise, 0);
  const last = ins[ins.length - 1];
  return {
    refundable: sum(ins.filter(r => r.refundable)) + sum(outR),
    credit: sum(ins.filter(r => !r.refundable)) + sum(outN),
    ...(last?._id ? { lastId: last._id } : {}),
  };
}

/** Marker written BEFORE a make-up day is appended: the plan's endDate at that moment. */
type PendingMakeup = { makeupPendingFrom?: string };

/** A make-up row appended after `from` that no delivery claims yet — the one a crashed attempt made. */
async function orphanMakeup(db: Db, sub: Subscription & { _id: ObjectId }, from: string): Promise<(Delivery & { _id: ObjectId }) | null> {
  const rows = await col.deliveries(db).find({ subscriptionId: sub._id, source: 'makeup', date: { $gt: from } }).sort({ date: 1 }).toArray();
  for (const r of rows) {
    if (r._id && (await col.deliveries(db).countDocuments({ compensationDeliveryId: r._id }, { limit: 1 })) === 0) {
      return r as Delivery & { _id: ObjectId };
    }
  }
  return null;
}

export async function compensateMissedDelivery(
  deliveryId: ObjectId,
  ctx: OpCtx,
): Promise<{ resolution: Resolution; alreadyResolved: boolean }> {
  const db = await getDb();
  const d = await col.deliveries(db).findOne({ _id: deliveryId });
  if (!d?._id) throw new NotFoundError('Delivery not found');
  if (d.resolution) return { resolution: d.resolution, alreadyResolved: true };
  if (d.status !== 'not_delivered' || d.fault !== 'ours') return { resolution: 'none', alreadyResolved: false };

  if (!(await claim(db, deliveryId, { resolution: { $exists: false }, status: 'not_delivered', fault: 'ours' }))) {
    const now = await col.deliveries(db).findOne({ _id: deliveryId }, { projection: { resolution: 1 } });
    // someone else holds it (or just finished) — never compensate twice
    return { resolution: now?.resolution ?? 'none', alreadyResolved: true };
  }

  try {
    const sub = await col.subscriptions(db).findOne({ _id: d.subscriptionId });
    if (!sub?._id) throw new Error(`compensation: subscription ${String(d.subscriptionId)} not found`);
    const user = await col.users(db).findOne({ mobile: d.mobile }, { projection: { missedDeliveryPreference: 1 } });
    const pref = user?.missedDeliveryPreference ?? 'makeup_day';
    const pendingFrom = (d as Delivery & PendingMakeup).makeupPendingFrom;

    let resolution: Resolution | null = null;
    const set: Partial<Delivery> = {};
    let customerText = '';

    if (d.source !== 'extra' && (pendingFrom !== undefined || (pref === 'makeup_day' && (await canExtend(db, sub, ctx))))) {
      const s = sub as Subscription & { _id: ObjectId };
      // A crashed earlier attempt may already have appended the day: adopt it.
      const adopted = pendingFrom !== undefined ? await orphanMakeup(db, s, pendingFrom) : null;
      if (adopted) {
        resolution = 'makeup_day';
        set.compensationDeliveryId = adopted._id;
        customerText = `one day added — your plan now ends on ${sub.endDate}`;
      } else if (await canExtend(db, sub, ctx)) {
        await col.deliveries(db).updateOne(
          { _id: deliveryId },
          { $set: { makeupPendingFrom: sub.endDate } } as UpdateFilter<Delivery>,
        );
        try {
          const { newEndDate, appended } = await extendSubscription(sub._id, 1, 'makeup', ctx);
          const makeup = await col.deliveries(db).findOne({ subscriptionId: sub._id, date: appended[0], source: 'makeup' });
          resolution = 'makeup_day';
          if (makeup?._id) set.compensationDeliveryId = makeup._id;
          customerText = `one day added — your plan now ends on ${newEndDate}`;
        } catch (err) {
          // the plan stopped running meanwhile: fall through to credit
          if (!(err instanceof ConflictError)) throw err;
        }
      }
    }

    if (!resolution) {
      const value = await missedValuePaise(db, d, sub);
      // keyed on the ledger (net per share): a retry after a crash adds nothing, a
      // re-compensation after a reversal adds a fresh entry
      const net = await netCredit(db, d as Delivery & { _id: ObjectId });
      let lastId = net.lastId;
      const add = async (amountPaise: number, refundable: boolean) => {
        if (amountPaise <= 0) return;
        const e = await addCredit(
          {
            mobile: d.mobile,
            amountPaise,
            kind: 'missed_delivery',
            refundable,
            deliveryId,
            subscriptionId: sub._id!,
            ...(d.orderId ? { orderId: d.orderId } : {}),
            note: `Missed delivery on ${d.date}${refundable ? '' : ' (paid from credit)'}`,
          },
          ctx,
        );
        if (e._id) lastId = e._id;
      };
      await add(value.refundable - net.refundable, true);
      await add(value.credit - net.credit, false);
      resolution = 'credit';
      if (lastId) set.compensationCreditId = lastId;
      customerText = `${formatINR(value.refundable + value.credit)} added to your Maavuli credit`;
    }

    const wrote = await col.deliveries(db).updateOne(
      { _id: deliveryId, resolution: { $exists: false }, status: 'not_delivered', fault: 'ours' },
      {
        $set: { ...set, resolution, resolvedAt: ctx.now, resolvedBy: ctx.actor, updatedAt: ctx.now },
        $unset: { makeupPendingFrom: '' },
      } as UpdateFilter<Delivery>,
    );
    if (wrote.matchedCount !== 1) {
      // The row stopped being our miss while we compensated (a delivered correction,
      // a fault change). Record what was given, then take it back.
      const w = await col.deliveries(db).updateOne(
        { _id: deliveryId, resolution: { $exists: false } },
        {
          $set: { ...set, resolution, resolvedAt: ctx.now, resolvedBy: ctx.actor, updatedAt: ctx.now },
          $unset: { makeupPendingFrom: '' },
        } as UpdateFilter<Delivery>,
      );
      if (w.matchedCount === 1) await undoHeld(db, deliveryId, ctx);
      return { resolution: 'none', alreadyResolved: false };
    }
    await recordEvent(
      ctx,
      {
        entity: 'delivery',
        entityId: deliveryId.toHexString(),
        type: 'delivery.compensated',
        mobile: d.mobile,
        data: { resolution, date: d.date, source: d.source ?? 'plan', preference: pref },
      },
      db,
    );
    if (d.reason !== 'disruption') {
      // disruptions get their own disruption_notice from the day engine
      await enqueueMessage(
        {
          mobile: d.mobile,
          template: 'not_delivered_ours',
          params: { date: d.date, resolution: customerText },
          dedupeKey: `missed:${deliveryId.toHexString()}`,
        },
        ctx,
      );
    }
    return { resolution, alreadyResolved: false };
  } finally {
    await release(db, deliveryId);
  }
}

/**
 * Remove one still-planned make-up day and pull the plan (and a queued renewal) back
 * by a day. Returns why not, when it cannot.
 */
async function retractMakeupDay(db: Db, makeup: Delivery & { _id: ObjectId }, ctx: OpCtx): Promise<string | null> {
  if (makeup.status !== 'planned') return `make-up day is already ${makeup.status}`;
  if (await isDateLocked(makeup.date, ctx, db)) return 'make-up day is already past its cutoff';
  const sub = await col.subscriptions(db).findOne({ _id: makeup.subscriptionId });
  if (!sub?._id) return 'subscription not found';

  const gone = await col.deliveries(db).deleteOne({ _id: makeup._id, status: 'planned' });
  if (gone.deletedCount !== 1) return 'make-up day changed while reversing';

  // Close the gap: the last planned day moves into the removed slot, so the plan
  // keeps a contiguous tail and simply ends one day earlier.
  if (makeup.date !== sub.endDate) {
    const tail = await col.deliveries(db).findOne({
      subscriptionId: sub._id,
      date: sub.endDate,
      status: 'planned',
      source: { $in: ['plan', 'makeup'] },
    });
    if (!tail?._id) {
      await recordEvent(ctx, {
        entity: 'subscription',
        entityId: sub._id.toHexString(),
        type: 'subscription.makeup_removed',
        mobile: sub.mobile,
        data: { date: makeup.date, endDate: sub.endDate, note: 'last day is not planned; end date unchanged' },
      }, db);
      return null;
    }
    await col.deliveries(db).updateOne({ _id: tail._id }, { $set: { date: makeup.date, updatedAt: ctx.now } });
  }
  const newEnd = addDays(sub.endDate, -1);
  await col.subscriptions(db).updateOne({ _id: sub._id, endDate: sub.endDate }, { $set: { endDate: newEnd } });

  // Mirror of extendSubscription: a queued, not-yet-started renewal moves back too.
  if (sub.renewedBy) {
    const ren = await col.subscriptions(db).findOne({ _id: sub.renewedBy });
    const newStart = ren ? addDays(ren.startDate, -1) : null;
    if (ren?._id && ren.status === 'scheduled' && newStart && !(await isDateLocked(newStart, ctx, db))) {
      const nonPlanned = await col.deliveries(db).countDocuments({ subscriptionId: ren._id, status: { $ne: 'planned' } }, { limit: 1 });
      if (!nonPlanned) {
        // EARLIEST FIRST: moving D → D−1 in ascending order never collides.
        const rows = await col.deliveries(db).find({ subscriptionId: ren._id }).sort({ date: 1 }).toArray();
        for (const r of rows) await col.deliveries(db).updateOne({ _id: r._id }, { $set: { date: addDays(r.date, -1), updatedAt: ctx.now } });
        await col.subscriptions(db).updateOne(
          { _id: ren._id },
          { $set: { startDate: newStart, endDate: addDays(ren.endDate, -1) } },
        );
        await recordEvent(ctx, {
          entity: 'subscription',
          entityId: ren._id.toHexString(),
          type: 'subscription.renewal_shifted',
          mobile: ren.mobile,
          data: { days: -1, startDate: newStart },
        }, db);
      }
    }
  }
  await recordEvent(ctx, {
    entity: 'subscription',
    entityId: sub._id.toHexString(),
    type: 'subscription.makeup_removed',
    mobile: sub.mobile,
    data: { date: makeup.date, newEndDate: newEnd },
  }, db);
  return null;
}

/**
 * Undo a compensation when the miss turns out not to be one: the delivery was
 * re-marked delivered, or staff changed its fault from 'ours' to 'customer'.
 * Clears delivery.resolution. Idempotent.
 */
export async function reverseCompensation(deliveryId: ObjectId, ctx: OpCtx): Promise<{ reversed: boolean }> {
  const db = await getDb();
  const d = await col.deliveries(db).findOne({ _id: deliveryId });
  if (!d) throw new NotFoundError('Delivery not found');
  if (!d.resolution || d.resolution === 'none') return { reversed: false };
  if (!(await claim(db, deliveryId, { resolution: d.resolution }))) return { reversed: false };
  try {
    return await undoHeld(db, deliveryId, ctx);
  } finally {
    await release(db, deliveryId);
  }
}

/**
 * The body of reverseCompensation, for a caller that already holds the claim.
 * When the compensation cannot be taken back (the make-up day already went out, the
 * credit was spent) the resolution STAYS set: the customer keeps what they got, and
 * a later flip back to 'ours' must not compensate the same miss a second time.
 */
async function undoHeld(db: Db, deliveryId: ObjectId, ctx: OpCtx): Promise<{ reversed: boolean }> {
  const d = await col.deliveries(db).findOne({ _id: deliveryId });
  if (!d?._id || !d.resolution || d.resolution === 'none') return { reversed: false };
  {
    let kept: string | null = null;
    if (d.resolution === 'makeup_day') {
      const makeup = d.compensationDeliveryId ? await col.deliveries(db).findOne({ _id: d.compensationDeliveryId }) : null;
      kept = makeup?._id ? await retractMakeupDay(db, makeup as Delivery & { _id: ObjectId }, ctx) : 'make-up day not found';
    } else {
      const dd = d as Delivery & { _id: ObjectId };
      kept = await withCreditLock(d.mobile, async ldb => {
        const net = await netCredit(ldb, dd);
        const r = Math.max(0, net.refundable);
        const c = Math.max(0, net.credit);
        if (r + c === 0) return null; // nothing (left) to take back
        const bal = foldBalance(await col.credits(ldb).find({ mobile: d.mobile }).toArray());
        if (bal.balancePaise < r + c) return 'credit already spent';
        const note = `Missed-delivery credit reversed (${d.date} was delivered / not our fault)`;
        if (r > 0) await spendLocked(ldb, d.mobile, r, 'adjustment', { deliveryId, subscriptionId: d.subscriptionId, note }, ctx);
        if (c > 0 && d.orderId) await spendLocked(ldb, d.mobile, c, 'adjustment', { orderId: d.orderId, subscriptionId: d.subscriptionId, note }, ctx);
        return null;
      });
    }

    if (!kept) {
      await col.deliveries(db).updateOne(
        { _id: deliveryId, resolution: d.resolution },
        { $unset: { resolution: '', compensationDeliveryId: '', compensationCreditId: '' }, $set: { updatedAt: ctx.now } },
      );
    }
    await recordEvent(
      ctx,
      {
        entity: 'delivery',
        entityId: deliveryId.toHexString(),
        type: kept ? 'delivery.compensation_kept' : 'delivery.compensation_reversed',
        mobile: d.mobile,
        ...(kept ? { reason: kept } : {}),
        data: { resolution: d.resolution, date: d.date },
      },
      db,
    );
    return { reversed: kept === null };
  }
}

/**
 * Tick step: compensate every not_delivered / fault 'ours' delivery that has no
 * `resolution` yet — the retry path when compensation failed after the outcome was
 * written. Errors are counted per delivery, never thrown.
 */
export async function compensatePendingMisses(ctx: OpCtx): Promise<{ compensated: number; failed: number }> {
  const db = await getDb();
  const pending = await col
    .deliveries(db)
    .find({ status: 'not_delivered', fault: 'ours', resolution: { $exists: false } }, { projection: { _id: 1 } })
    .sort({ date: 1 })
    .limit(200)
    .toArray();
  let compensated = 0;
  let failed = 0;
  for (const p of pending) {
    try {
      const r = await compensateMissedDelivery(p._id, ctx);
      if (!r.alreadyResolved && r.resolution !== 'none') compensated++;
    } catch (err) {
      failed++;
      // eslint-disable-next-line no-console
      console.error('[compensation] sweep failed', String(p._id), err instanceof Error ? err.message : err);
    }
  }
  return { compensated, failed };
}
