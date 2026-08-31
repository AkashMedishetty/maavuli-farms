import { NextResponse } from 'next/server';
import {
  issueOtp,
  InvalidMobileError,
  RateLimitError,
  SmsNotConfiguredError,
} from '@/lib/auth';
import { NotConfiguredError } from '@/lib/db';

/**
 * POST /api/auth/request  { mobile }
 *
 * Issues a one-time code. The response is INTENTIONALLY the same for a registered
 * and an unregistered mobile — revealing which numbers have accounts is an
 * enumeration leak. In development with no SMS provider, the code is returned as
 * `devCode` so the flow can be completed locally.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const mobile = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).mobile : undefined;
  if (typeof mobile !== 'string') {
    return NextResponse.json({ error: 'A mobile number is required.' }, { status: 400 });
  }

  try {
    const result = await issueOtp(mobile);
    // devCode is present only in non-production with no SMS provider configured.
    return NextResponse.json(result.devCode ? { ok: true, devCode: result.devCode } : { ok: true });
  } catch (err) {
    if (err instanceof InvalidMobileError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: err.message, retryAfter: err.retryAfterSeconds },
        { status: 429, headers: { 'Retry-After': String(err.retryAfterSeconds) } },
      );
    }
    if (err instanceof SmsNotConfiguredError) {
      return NextResponse.json({ error: err.message, missing: err.missing }, { status: 503 });
    }
    if (err instanceof NotConfiguredError) {
      return NextResponse.json({ error: err.message, missing: err.missing }, { status: 503 });
    }
    throw err;
  }
}
