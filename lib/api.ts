/**
 * Route-handler helpers so every API answers errors the same way.
 *
 * Pattern for every app/api/** handler:
 *
 *   export const dynamic = 'force-dynamic';
 *   export async function POST(req: Request) {
 *     try {
 *       const p = await requireStaff(['owner', 'ops']);
 *       const body = await readJson(req);
 *       const ctx = ctxFor(req, actorFor(p, 'staff'));
 *       ...
 *       return ok({ ... });
 *     } catch (err) {
 *       return handleRouteError(err);
 *     }
 *   }
 *
 * Errors carry meaning (lib/errors); this file is the only place they become status
 * codes. Unknown errors are logged and answered with a generic 500 — never a stack
 * trace, never a secret.
 */

import { NextResponse } from 'next/server';
import { NotConfiguredError } from './db';
import { RateLimitError, SmsNotConfiguredError, UnauthorizedError, VerifyError } from './auth';
import { NotAdminError } from './admin';
import {
  ConflictError,
  DateLockedError,
  ForbiddenError,
  NotFoundError,
  ServiceNotConfiguredError,
  UpstreamError,
  ValidationError,
} from './errors';
import { IllegalTransitionError } from './transitions';

export function ok<T extends Record<string, unknown>>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers: { 'cache-control': 'no-store' } });
}

/** Parse a JSON body or throw ValidationError (→ 400). */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const body: unknown = await req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Body must be a JSON object');
    }
    return body as T;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('Invalid JSON body');
  }
}

export function handleRouteError(err: unknown): NextResponse {
  if (err instanceof ValidationError) return jsonError(400, err.message, { issues: err.issues });
  if (err instanceof VerifyError) return jsonError(400, err.message);
  if (err instanceof UnauthorizedError) return jsonError(401, err.message);
  if (err instanceof ForbiddenError || err instanceof NotAdminError) return jsonError(403, err.message);
  if (err instanceof NotFoundError) return jsonError(404, err.message);
  if (err instanceof DateLockedError) {
    return jsonError(409, err.message, { code: 'date_locked', date: err.date, firstOpen: err.firstOpen });
  }
  if (err instanceof IllegalTransitionError) {
    return jsonError(409, 'That change is not possible in the current state.', {
      code: 'illegal_transition',
      entity: err.entity,
      from: err.from,
      to: err.to,
    });
  }
  if (err instanceof ConflictError) return jsonError(409, err.message, { code: 'conflict', ...(err.data ?? {}) });
  if (err instanceof RateLimitError) {
    return NextResponse.json(
      { error: err.message, retryAfter: err.retryAfterSeconds },
      { status: 429, headers: { 'retry-after': String(err.retryAfterSeconds), 'cache-control': 'no-store' } },
    );
  }
  if (err instanceof NotConfiguredError) {
    return jsonError(503, 'Database not configured', { missing: err.missing });
  }
  if (err instanceof SmsNotConfiguredError) return jsonError(503, 'Sign-in codes are not configured', { missing: err.missing });
  if (err instanceof ServiceNotConfiguredError) {
    return jsonError(503, err.message, { service: err.service, missing: err.missing });
  }
  if (err instanceof UpstreamError) return jsonError(502, err.message, { service: err.service });
  // eslint-disable-next-line no-console
  console.error('[api] unhandled', err);
  return jsonError(500, 'Something went wrong on our side. Please try again.');
}
