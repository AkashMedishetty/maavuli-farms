/**
 * POST /api/admin/tickets/[id]/resolve  { resolution }  — resolve a ticket. OWNER: B6.
 * Access: owner, ops, support. Enqueues a ticket_update WhatsApp to the customer.
 */

import { ObjectId } from 'mongodb';
import { requireStaff, actorFor } from '@/lib/roles';
import { resolveTicket } from '@/lib/tickets';
import { ctxFor } from '@/lib/clock';
import { ok, readJson, handleRouteError } from '@/lib/api';
import { ValidationError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const p = await requireStaff(['owner', 'ops', 'support']);
    const { id } = await params;
    if (!ObjectId.isValid(id)) throw new ValidationError('Invalid ticket id');

    const body = await readJson<{ resolution?: unknown }>(req);
    if (typeof body.resolution !== 'string' || body.resolution.trim() === '') {
      throw new ValidationError('A resolution note is required');
    }

    const ctx = ctxFor(req, actorFor(p, 'staff'));
    const ticket = await resolveTicket(new ObjectId(id), body.resolution, ctx);
    return ok({ ticket });
  } catch (err) {
    return handleRouteError(err);
  }
}
