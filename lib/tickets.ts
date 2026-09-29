/**
 * Support tickets. OWNER: B6 (backend; the customer UI is B9, the admin UI B7b).
 * Keep the signatures; replace the bodies.
 */

import type { ObjectId } from 'mongodb';
import type { Ticket, TicketKind } from './models';
import type { OpCtx } from './clock';

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
  void input;
  void ctx;
  throw new Error('not implemented: createTicket (owner B6)');
}

export async function resolveTicket(ticketId: ObjectId, resolution: string, ctx: OpCtx): Promise<Ticket> {
  void ticketId;
  void resolution;
  void ctx;
  throw new Error('not implemented: resolveTicket (owner B6)');
}

export async function listTickets(filter: { mobile?: string; status?: Ticket['status'] }, limit?: number): Promise<Ticket[]> {
  void filter;
  void limit;
  throw new Error('not implemented: listTickets (owner B6)');
}
