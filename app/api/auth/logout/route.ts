import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { destroySession, SESSION_COOKIE } from '@/lib/auth';
import { NotConfiguredError } from '@/lib/db';
import { handleRouteError } from '@/lib/api';

// Reads cookies/sessions on every request; never prerender or cache.
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/logout
 *
 * Destroys the current session (by the raw cookie token) and clears the cookie.
 * Idempotent: calling it without a session still returns ok and clears the cookie.
 */
export async function POST(): Promise<NextResponse> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value ?? '';
  try {
    await destroySession(raw);
  } catch (err) {
    // If the DB is unreachable we still clear the cookie so the browser is signed
    // out; only surface a hard failure the caller could not have caused.
    if (!(err instanceof NotConfiguredError)) return handleRouteError(err);
    jar.delete(SESSION_COOKIE);
  }
  return NextResponse.json({ ok: true });
}
