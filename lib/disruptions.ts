/**
 * Service disruptions: "rain in Safilguda today", "the van broke down", "farm
 * closed for the festival". One action marks every affected delivery as not
 * delivered, OUR fault (reason 'disruption'), so each customer is compensated
 * exactly like any other miss we cause — and sends one WhatsApp per customer.
 *
 * A disruption on a date that has not locked yet locks it first: the affected
 * deliveries must be frozen with their rider and snapshot before they can be
 * marked, and a customer must not be able to "pause" a day we already know we
 * cannot deliver (and so keep both the pause and the compensation).
 */

import { ObjectId } from 'mongodb';
import { getDb } from './db';
import { col, type Delivery, type Disruption } from './models';
import type { OpCtx } from './clock';
import { recordEvent } from './events';
import { addDaysYMD, isYMD, istYMD } from './cutoff';
import { dateLabel, lockDay } from './manifest';
import { markNotDelivered } from './outcomes';
import { enqueueMessage } from './notify';
import { ValidationError } from './errors';

/** How far ahead a disruption may be declared. */
export const MAX_DAYS_AHEAD = 7;

export interface DisruptionInput {
  date: string;
  /** empty = every zone */
  zoneIds: ObjectId[];
  reason: string;
}

export interface DisruptionResult {
  disruption: Disruption;
  affected: number;
  customers: number;
  failed: number;
}

const RESOLUTION_COPY = {
  makeup_day: 'We have added a day to the end of your plan.',
  credit: 'The value of the day is in your Maavuli credit.',
  none: 'Our team will contact you.',
} as const;

export async function createDisruption(input: DisruptionInput, ctx: OpCtx): Promise<DisruptionResult> {
  const reason = input.reason.trim();
  if (!isYMD(input.date)) throw new ValidationError('date must be YYYY-MM-DD');
  if (reason.length < 3 || reason.length > 200) throw new ValidationError('reason must be 3–200 characters');
  const today = istYMD(ctx.now);
  if (input.date < today) throw new ValidationError('A disruption cannot be declared for a past date.');
  if (input.date > addDaysYMD(today, MAX_DAYS_AHEAD)) {
    throw new ValidationError(`A disruption can be declared at most ${MAX_DAYS_AHEAD} days ahead.`);
  }

  const db = await getDb();
  if (input.zoneIds.length) {
    const found = await col.zones(db).countDocuments({ _id: { $in: input.zoneIds } });
    if (found !== input.zoneIds.length) throw new ValidationError('One or more zones do not exist.');
  }

  // Freeze the day first (no-op when already locked).
  await lockDay(input.date, ctx);

  const filter: Record<string, unknown> = {
    date: input.date,
    status: { $in: ['locked', 'out_for_delivery', 'unconfirmed'] as Delivery['status'][] },
  };
  if (input.zoneIds.length) filter['snapshot.zoneId'] = { $in: input.zoneIds };
  const rows = await col.deliveries(db).find(filter).project<{ _id: ObjectId; mobile: string }>({ _id: 1, mobile: 1 }).toArray();

  const disruptionId = new ObjectId();
  const perCustomer = new Map<string, keyof typeof RESOLUTION_COPY>();
  let affected = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const d = await markNotDelivered(r._id, { reason: 'disruption', note: reason }, ctx);
      affected++;
      if (!perCustomer.has(r.mobile)) perCustomer.set(r.mobile, d.resolution ?? 'none');
    } catch (err) {
      failed++;
      // eslint-disable-next-line no-console
      console.error('[disruptions] could not mark', r._id.toHexString(), err instanceof Error ? err.message : err);
    }
  }

  const disruption: Disruption = {
    _id: disruptionId,
    date: input.date,
    zoneIds: input.zoneIds,
    reason,
    affected,
    createdBy: ctx.actor,
    createdAt: ctx.now,
  };
  await col.disruptions(db).insertOne(disruption);

  for (const [mobile, resolution] of perCustomer) {
    await enqueueMessage(
      {
        mobile,
        template: 'disruption_notice',
        params: { date: dateLabel(input.date), reason, resolution: RESOLUTION_COPY[resolution] },
        dedupeKey: `disruption:${disruptionId.toHexString()}:${mobile}`,
      },
      ctx,
    );
  }

  await recordEvent(
    ctx,
    {
      entity: 'day',
      entityId: input.date,
      type: 'day.disrupted',
      reason,
      data: { disruptionId: disruptionId.toHexString(), affected, failed, customers: perCustomer.size, zones: input.zoneIds.map(String) },
    },
    db,
  );

  return { disruption, affected, customers: perCustomer.size, failed };
}

export async function listDisruptions(from: string, to: string): Promise<Disruption[]> {
  const db = await getDb();
  return col.disruptions(db).find({ date: { $gte: from, $lte: to } }).sort({ date: -1, createdAt: -1 }).limit(200).toArray();
}
