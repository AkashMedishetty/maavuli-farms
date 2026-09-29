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
 * twice. The make-up path has a one-write window (extend → resolution) — see report.
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
import { NotFoundError } from './errors';

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

/** The value of the missed day at the price actually paid. */
async function missedValuePaise(db: Db, d: Delivery, sub: Subscription): Promise<number> {
  if (d.source === 'extra') {
    const o = d.orderId ? await col.orders(db).findOne({ _id: d.orderId }) : null;
    if (!o) throw new Error(`compensation: extra order for delivery ${String(d._id)} not found`);
    return o.amountPaise;
  }
  const o = await col.orders(db).findOne({ _id: sub.orderId });
  if (!o) throw new Error(`compensation: order for subscription ${String(sub._id)} not found`);
  return Math.round(o.perLitrePaise * d.litres);
}

export async function compensateMissedDelivery(
  deliveryId: ObjectId,
  ctx: OpCtx,
): Promise<{ resolution: Resolution; alreadyResolved: boolean }> {
  const db = await getDb();
  const d = await col.deliveries(db).findOne({ _id: deliveryId });
  if (!d) throw new NotFoundError('Delivery not found');
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

    let resolution: Resolution;
    const set: Partial<Delivery> = {};
    let customerText: string;

    if (d.source !== 'extra' && pref === 'makeup_day' && (await canExtend(db, sub, ctx))) {
      const { newEndDate, appended } = await extendSubscription(sub._id, 1, 'makeup', ctx);
      const makeup = await col.deliveries(db).findOne({ subscriptionId: sub._id, date: appended[0], source: 'makeup' });
      resolution = 'makeup_day';
      if (makeup?._id) set.compensationDeliveryId = makeup._id;
      customerText = `one day added — your plan now ends on ${newEndDate}`;
    } else {
      const value = await missedValuePaise(db, d, sub);
      // keyed on the ledger: a retry after a crash finds the credit already there
      const prior = await col.credits(db).findOne({ deliveryId, kind: 'missed_delivery' });
      const entry =
        prior ??
        (await addCredit(
          {
            mobile: d.mobile,
            amountPaise: value,
            kind: 'missed_delivery',
            refundable: true,
            deliveryId,
            subscriptionId: sub._id,
            ...(d.orderId ? { orderId: d.orderId } : {}),
            note: `Missed delivery on ${d.date}`,
          },
          ctx,
        ));
      resolution = 'credit';
      if (entry._id) set.compensationCreditId = entry._id;
      customerText = `${formatINR(value)} added to your Maavuli credit`;
    }

    await col.deliveries(db).updateOne(
      { _id: deliveryId, resolution: { $exists: false } },
      { $set: { ...set, resolution, resolvedAt: ctx.now, resolvedBy: ctx.actor, updatedAt: ctx.now } },
    );
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
    let kept: string | null = null;
    if (d.resolution === 'makeup_day') {
      const makeup = d.compensationDeliveryId ? await col.deliveries(db).findOne({ _id: d.compensationDeliveryId }) : null;
      kept = makeup?._id ? await retractMakeupDay(db, makeup as Delivery & { _id: ObjectId }, ctx) : 'make-up day not found';
    } else {
      const credit = d.compensationCreditId
        ? await col.credits(db).findOne({ _id: d.compensationCreditId })
        : await col.credits(db).findOne({ deliveryId, kind: 'missed_delivery' });
      if (!credit) kept = 'credit entry not found';
      else {
        kept = await withCreditLock(d.mobile, async ldb => {
          const already = await col.credits(ldb).findOne({ deliveryId, kind: 'adjustment', amountPaise: -credit.amountPaise });
          if (already) return null;
          const bal = foldBalance(await col.credits(ldb).find({ mobile: d.mobile }).toArray());
          if (bal.balancePaise < credit.amountPaise) return 'credit already spent';
          await spendLocked(
            ldb,
            d.mobile,
            credit.amountPaise,
            'adjustment',
            { deliveryId, subscriptionId: d.subscriptionId, note: `Missed-delivery credit reversed (${d.date} was delivered / not our fault)` },
            ctx,
          );
          return null;
        });
      }
    }

    await col.deliveries(db).updateOne(
      { _id: deliveryId, resolution: d.resolution },
      { $unset: { resolution: '', compensationDeliveryId: '', compensationCreditId: '' }, $set: { updatedAt: ctx.now } },
    );
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
  } finally {
    await release(db, deliveryId);
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
