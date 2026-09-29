import { ctxFor } from '@/lib/clock';
import { actorFor, requireRider } from '@/lib/roles';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { ValidationError } from '@/lib/errors';
import { applyActions, closeRun, startRun } from '@/lib/rider';

export const dynamic = 'force-dynamic';

/**
 * POST /api/rider/actions — the phone's single write endpoint. One request may:
 *  · { op: 'start_run' }
 *  · { op: 'close_run', returns?: { cowLitres?, buffaloLitres?, note? } }
 *  · { op: 'actions', actions: RiderActionInput[] }   (batch, ≤ 50, idempotent)
 * Everything is scoped to the signed-in rider's own run.
 */
export async function POST(req: Request) {
  try {
    const p = await requireRider();
    const body = await readJson<{ op?: unknown; actions?: unknown; returns?: unknown }>(req);
    const ctx = ctxFor(req, actorFor(p, 'rider'));
    const op = body.op;

    if (op === 'start_run') {
      const run = await startRun(p.riderId, ctx);
      return ok({ op, status: run.status, startedAt: run.startedAt });
    }

    if (op === 'close_run') {
      const r = (body.returns ?? {}) as Record<string, unknown>;
      const returns = {
        ...(typeof r.cowLitres === 'number' ? { cowLitres: r.cowLitres } : {}),
        ...(typeof r.buffaloLitres === 'number' ? { buffaloLitres: r.buffaloLitres } : {}),
        ...(typeof r.note === 'string' ? { note: r.note } : {}),
      };
      const run = await closeRun(p.riderId, returns, ctx);
      return ok({ op, status: run.status, returns: run.returns });
    }

    if (op === 'actions') {
      if (!Array.isArray(body.actions)) throw new ValidationError('actions must be an array');
      const results = await applyActions(p.riderId, body.actions as unknown[], ctx);
      return ok({ op, results });
    }

    throw new ValidationError('Unknown op — expected start_run | close_run | actions');
  } catch (err) {
    return handleRouteError(err);
  }
}
