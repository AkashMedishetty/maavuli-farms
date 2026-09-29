import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { NotConfiguredError } from '@/lib/db';

/**
 * GET /api/auth/me
 *
 * Returns the current session's public shape, or { authenticated: false } when
 * there is none. Never leaks the session token or any secret. 200 in both cases —
 * "not signed in" is a normal state, not an error.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ authenticated: false });

    return NextResponse.json({
      authenticated: true,
      mobile: session.mobile,
      isAdmin: session.isAdmin,
      name: session.user?.name ?? null,
      // the customer's own consent state, so forms can show it (never another user's)
      whatsappOptIn: session.user?.whatsappOptIn === true,
      expiresAt: session.expiresAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return NextResponse.json({ error: err.message, missing: err.missing }, { status: 503 });
    }
    throw err;
  }
}
