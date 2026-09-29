/**
 * The append-only event log: audit trail, customer timeline and notification
 * trigger in one.
 *
 * Every state transition writes exactly one event AFTER the state change succeeds.
 * recordEvent never throws: a lost audit line is bad, but failing a customer's
 * cancellation after it already happened is worse — so a failed write is logged
 * loudly and the caller carries on.
 */

import type { Db } from 'mongodb';
import { getDb } from './db';
import { col, type DomainEvent } from './models';
import type { OpCtx } from './clock';

export type NewEvent = Omit<DomainEvent, '_id' | 'at' | 'actor'> & { at?: Date };

export async function recordEvent(ctx: OpCtx, ev: NewEvent, db?: Db): Promise<void> {
  try {
    const d = db ?? (await getDb());
    await col.events(d).insertOne({ ...ev, actor: ctx.actor, at: ev.at ?? ctx.now });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[events] failed to record', ev.type, ev.entityId, err instanceof Error ? err.message : err);
  }
}

/** A customer's timeline, newest first. */
export async function customerTimeline(mobile: string, limit = 100): Promise<DomainEvent[]> {
  const db = await getDb();
  return col.events(db).find({ mobile }).sort({ at: -1 }).limit(limit).toArray();
}

/** Every event for one entity, oldest first. */
export async function entityHistory(entityId: string, limit = 200): Promise<DomainEvent[]> {
  const db = await getDb();
  return col.events(db).find({ entityId }).sort({ at: 1 }).limit(limit).toArray();
}
