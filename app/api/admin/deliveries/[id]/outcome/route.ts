import { ctxFor } from '@/lib/clock';
import { actorFor, requireStaff } from '@/lib/roles';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { ValidationError } from '@/lib/errors';
import { REASON_FAULT, type Fault, type NotDeliveredReason } from '@/lib/models';
import { clearProofFlag, markDelivered, markNotDelivered, setFault } from '@/lib/outcomes';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/deliveries/[id]/outcome — owner/ops resolve a delivery.
 * Body: { action: 'delivered' | 'not_delivered' | 'set_fault' | 'clear_flag', reason?, fault?, note? }
 *  · delivered      — an ops correction; a note is enough (no camera at a desk).
 *  · not_delivered  — reason required; ops MAY set an explicit fault.
 *  · set_fault      — resolve a not_delivered(unknown); fault ours|customer.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const { id } = await params;
    const body = await readJson<{ action?: unknown; reason?: unknown; fault?: unknown; note?: unknown }>(req);
    const ctx = ctxFor(req, actorFor(p, 'staff'));
    const { ObjectId } = await import('mongodb');

    let deliveryId;
    try {
      deliveryId = new ObjectId(id);
    } catch {
      throw new ValidationError('invalid delivery id');
    }

    const action = body.action;
    const note = typeof body.note === 'string' ? body.note : undefined;

    if (action === 'delivered') {
      // A desk correction has no doorstep photo, so a note is required; markDelivered
      // stores it in the same update as the status change.
      if (!note || note.trim() === '') {
        throw new ValidationError('A note is required when marking delivered from the admin console.');
      }
      const updated = await markDelivered(deliveryId, { capturedAt: ctx.now }, ctx, { note });
      return ok({ status: updated.status });
    }

    if (action === 'clear_flag') {
      if (!note || note.trim() === '') throw new ValidationError('Say why the proof is accepted.');
      const updated = await clearProofFlag(deliveryId, note, ctx);
      return ok({ status: updated.status, flagged: updated.proof?.flagged === true });
    }

    if (action === 'not_delivered') {
      const reason = body.reason;
      if (typeof reason !== 'string' || !Object.hasOwn(REASON_FAULT, reason)) {
        throw new ValidationError('a valid reason is required');
      }
      const fault = typeof body.fault === 'string' ? (body.fault as Fault) : undefined;
      if (fault && !['ours', 'customer', 'unknown'].includes(fault)) {
        throw new ValidationError('fault must be ours | customer | unknown');
      }
      const updated = await markNotDelivered(
        deliveryId,
        { reason: reason as NotDeliveredReason, ...(note ? { note } : {}), ...(fault ? { fault } : {}) },
        ctx,
      );
      return ok({ status: updated.status, fault: updated.fault });
    }

    if (action === 'set_fault') {
      const fault = body.fault;
      if (fault !== 'ours' && fault !== 'customer') {
        throw new ValidationError('fault must be ours | customer');
      }
      const updated = await setFault(deliveryId, fault, ctx);
      return ok({ status: updated.status, fault: updated.fault });
    }

    throw new ValidationError('action must be delivered | not_delivered | set_fault | clear_flag');
  } catch (err) {
    return handleRouteError(err);
  }
}
