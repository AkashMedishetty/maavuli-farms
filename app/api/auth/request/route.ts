import { NextResponse } from 'next/server';
import {
  issueOtp,
  clientIpFrom,
  InvalidMobileError,
  OtpDeliveryError,
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
    const result = await issueOtp(mobile, { ip: clientIpFrom(req.headers) });
    /*
     * devCode is present when no SMS provider is configured — in development, or in
     * production with OTP_DEMO_MODE explicitly on. `demo` tells the client to show a
     * test-mode warning rather than presenting an on-screen code as normal.
     * `adminCodeWithheld` means a code WAS minted and logged but is not being
     * returned, because the mobile is on the admin allowlist.
     */
    return NextResponse.json({
      ok: true,
      ...(result.devCode ? { devCode: result.devCode } : {}),
      ...(result.demo ? { demo: true } : {}),
      ...(result.adminCodeWithheld
        ? {
            adminCodeWithheld: true,
            message:
              'This is an admin number, so the code is not shown on screen. Read it from the server logs.',
          }
        : {}),
    });
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
    if (err instanceof OtpDeliveryError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    if (err instanceof NotConfiguredError) {
      return NextResponse.json({ error: err.message, missing: err.missing }, { status: 503 });
    }
    throw err;
  }
}
