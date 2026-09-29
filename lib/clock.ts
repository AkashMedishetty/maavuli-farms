/**
 * Business time and operation context.
 *
 * RULE: lib code never calls `new Date()` for a business decision (cutoffs, what
 * "today" is, when an order expires). It receives `ctx.now`. Route handlers and the
 * cron tick build the context here — which is the one place a test can move time.
 *
 * Time travel: outside production, when MAAVULI_TIME_TRAVEL=1, a request may carry
 * `x-maavuli-now: <ISO instant>` and every decision in that request is made as of
 * that instant. `next start` / Vercel always run with NODE_ENV=production, so the
 * header is ignored there no matter what the env says. Timestamps that record WHEN
 * something physically happened (createdAt, receivedAt) may still use real time.
 */

import type { Actor } from './models';

export interface OpCtx {
  /** the business "now" every decision in this operation is made against */
  now: Date;
  /** who is doing it — recorded on every DomainEvent */
  actor: Actor;
}

export const NOW_HEADER = 'x-maavuli-now';

export const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'system' };

export function timeTravelAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.MAAVULI_TIME_TRAVEL === '1';
}

function parseOverride(raw: string | null | undefined): Date | null {
  if (!raw || !timeTravelAllowed()) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Business now for a route handler request. */
export function requestNow(req?: Request | null): Date {
  return parseOverride(req?.headers.get(NOW_HEADER)) ?? new Date();
}

/** Business now for a server component / server action (reads the incoming headers). */
export async function pageNow(): Promise<Date> {
  if (!timeTravelAllowed()) return new Date();
  const { headers } = await import('next/headers');
  const h = await headers();
  return parseOverride(h.get(NOW_HEADER)) ?? new Date();
}

export function ctxFor(req: Request | null, actor: Actor): OpCtx {
  return { now: requestNow(req), actor };
}

export function systemCtx(now: Date, job = 'system'): OpCtx {
  return { now, actor: { kind: 'system', id: job } };
}

export function customerActor(mobile: string): Actor {
  return { kind: 'customer', id: mobile };
}

export function staffActor(mobile: string): Actor {
  return { kind: 'staff', id: mobile };
}

export function riderActor(mobile: string): Actor {
  return { kind: 'rider', id: mobile };
}
