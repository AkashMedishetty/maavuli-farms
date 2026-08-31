import { NextResponse } from 'next/server';
import { verifyOtp, VerifyError } from '@/lib/auth';
import { NotConfiguredError } from '@/lib/db';

/**
 * POST /api/auth/verify  { mobile, code }
 *
 * On success sets the mv_session cookie and returns { ok: true }. A wrong or
 * expired code returns a single generic 401 — the caller cannot tell "wrong code"
 * from "no request for this number", which is deliberate.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const { mobile, code } = record;
  if (typeof mobile !== 'string' || typeof code !== 'string') {
    return NextResponse.json({ error: 'Mobile and code are required.' }, { status: 400 });
  }

  try {
    await verifyOtp(mobile, code);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof VerifyError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof NotConfiguredError) {
      return NextResponse.json({ error: err.message, missing: err.missing }, { status: 503 });
    }
    throw err;
  }
}
