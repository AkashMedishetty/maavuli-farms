/**
 * Support tickets. OWNER: B6 (backend; the customer UI is B9, the admin UI B7b).
 *
 * A ticket is a customer-raised issue (web form, a WhatsApp "REPORT_ISSUE", or a
 * staff member logging one). It has exactly two states — open → resolved — and
 * resolving one notifies the customer via the ticket_update template.
 */

import type { ObjectId } from 'mongodb';
import { getDb } from './db';
import { col, normalizeMobile, type Ticket, type TicketKind } from './models';
import { recordEvent } from './events';
import { NotFoundError, ValidationError } from './errors';
import { enqueueMessage } from './notify';
import type { OpCtx } from './clock';

const KINDS: readonly TicketKind[] = ['not_received', 'spoiled', 'quantity', 'other'];
const CHANNELS: readonly Ticket['channel'][] = ['web', 'whatsapp', 'staff'];
export const RESOLUTION_MAX = 500;

export async function createTicket(
  input: {
    mobile: string;
    kind: TicketKind;
    channel: Ticket['channel'];
    deliveryId?: ObjectId;
    subscriptionId?: ObjectId;
    note?: string;
    photoKey?: string;
  },
  ctx: OpCtx,
): Promise<Ticket> {
  const mobile = normalizeMobile(input.mobile);
  if (!mobile) throw new ValidationError('A valid mobile number is required');
  if (!KINDS.includes(input.kind)) throw new ValidationError('Unknown ticket kind', [`kind "${input.kind}"`]);
  if (!CHANNELS.includes(input.channel)) throw new ValidationError('Unknown ticket channel', [`channel "${input.channel}"`]);

  const db = await getDb();
  const now = ctx.now;
  const doc: Ticket = {
    mobile,
    kind: input.kind,
    status: 'open',
    channel: input.channel,
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.photoKey ? { photoKey: input.photoKey } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const res = await col.tickets(db).insertOne(doc);
  const ticket: Ticket = { ...doc, _id: res.insertedId };

  await recordEvent(
    ctx,
    {
      entity: 'ticket',
      entityId: res.insertedId.toHexString(),
      type: 'ticket.created',
      mobile,
      to: 'open',
      data: { kind: input.kind, channel: input.channel },
    },
    db,
  );
  return ticket;
}

export async function resolveTicket(ticketId: ObjectId, resolution: string, ctx: OpCtx): Promise<Ticket> {
  const trimmed = (typeof resolution === 'string' ? resolution : '').trim();
  if (!trimmed) throw new ValidationError('A resolution note is required');
  // It is sent verbatim to the customer as a WhatsApp template parameter.
  if (trimmed.length > RESOLUTION_MAX) {
    throw new ValidationError(`The resolution note can be at most ${RESOLUTION_MAX} characters`);
  }

  const db = await getDb();
  const now = ctx.now;

  // Conditional update matching the FROM state, so two resolvers cannot both win and
  // two notifications never fire. matchedCount tells us whether WE resolved it.
  const res = await col.tickets(db).findOneAndUpdate(
    { _id: ticketId, status: 'open' },
    { $set: { status: 'resolved', resolution: trimmed, resolvedBy: ctx.actor, updatedAt: now } },
    { returnDocument: 'after' },
  );

  if (!res) {
    // either the id is unknown, or it was already resolved
    const existing = await col.tickets(db).findOne({ _id: ticketId });
    if (!existing) throw new NotFoundError('Ticket not found');
    return existing; // already resolved — idempotent, no second notification
  }

  await recordEvent(
    ctx,
    {
      entity: 'ticket',
      entityId: ticketId.toHexString(),
      type: 'ticket.resolved',
      mobile: res.mobile,
      from: 'open',
      to: 'resolved',
      reason: trimmed,
    },
    db,
  );

  await enqueueMessage(
    {
      mobile: res.mobile,
      template: 'ticket_update',
      params: { status: 'Resolved', note: trimmed },
      dedupeKey: `ticket:${ticketId.toHexString()}:resolved`,
    },
    ctx,
  );

  return res;
}

export async function listTickets(
  filter: { mobile?: string; status?: Ticket['status'] },
  limit = 100,
): Promise<Ticket[]> {
  const db = await getDb();
  const q: Record<string, unknown> = {};
  if (filter.mobile) {
    const m = normalizeMobile(filter.mobile);
    if (m) q.mobile = m;
  }
  if (filter.status) q.status = filter.status;
  return col
    .tickets(db)
    .find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .toArray();
}
