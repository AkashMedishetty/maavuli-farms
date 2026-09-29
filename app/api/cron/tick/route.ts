import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, jsonError, ok } from '@/lib/api';
import { runTick } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
// a full tick is a few seconds at this scale; the ceiling is generous
export const maxDuration = 300;

/**
 * GET|POST /api/cron/tick — the scheduler's single entry point (Vercel Cron, every
 * 5 minutes, see vercel.json). Vercel sends `Authorization: Bearer $CRON_SECRET`
 * when CRON_SECRET is set in the project env; nothing else may call this.
 *
 *   ?force=1          ignore per-step min intervals (manual run)
 *   ?only=a,b         run only these steps
 */
function authorised(req: Request): NextResponse | null {
  const secret = (process.env.CRON_SECRET ?? '').trim();
  if (!secret) return jsonError(503, 'Scheduled jobs are not configured', { missing: ['CRON_SECRET'] });
  const header = req.headers.get('authorization') ?? '';
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return jsonError(401, 'Unauthorised');
  }
  return null;
}

async function handle(req: Request): Promise<NextResponse> {
  const denied = authorised(req);
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    const only = url.searchParams.get('only');
    const ctx = ctxFor(req, { kind: 'system', id: 'cron' });
    const steps = await runTick(ctx, {
      force: url.searchParams.get('force') === '1',
      ...(only ? { only: only.split(',').map(s => s.trim()).filter(Boolean) } : {}),
    });
    const failed = steps.filter(s => !s.ok).length;
    return ok({ ok: failed === 0, now: ctx.now.toISOString(), failed, steps });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
