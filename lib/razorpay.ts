import { createHmac, timingSafeEqual } from 'node:crypto';
import { razorpayConfig } from './env';

/**
 * Razorpay access WITHOUT the `razorpay` npm package.
 *
 * On a payment path, every dependency is attack surface and a supply-chain risk,
 * so we talk to the REST API with `fetch` and do the HMAC with node:crypto. The
 * whole SDK we would otherwise pull in is, for our needs, exactly this file.
 *
 * PREPAID ORDERS ONLY. We create Orders (one payment for a fixed term). We do NOT
 * touch Subscriptions / mandates / UPI Autopay — that fork is unconfirmed by the
 * client (see BACKEND-CONTRACT.md).
 */

const API_BASE = 'https://api.razorpay.com/v1';

/**
 * The narrow slice of the Razorpay Orders response we actually rely on. Razorpay
 * returns more; we model only what we read so a schema drift elsewhere cannot
 * silently feed us a wrong shape.
 */
export interface RazorpayOrder {
  id: string;
  entity: 'order';
  amount: number; // paise
  currency: string;
  receipt: string | null;
  status: 'created' | 'attempted' | 'paid';
}

export interface CreateOrderInput {
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}

/** Basic auth header from key id + secret. Never logged. */
function authHeader(keyId: string, keySecret: string): string {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

/**
 * Create a prepaid Razorpay Order. The amount is in paise and is decided by the
 * caller from the server-side quote — never by the client.
 *
 * Throws when Razorpay is not configured (the route turns that into a 503 with the
 * missing variable names) or when the API rejects the request.
 */
export async function createOrder({ amountPaise, receipt, notes }: CreateOrderInput): Promise<RazorpayOrder> {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new Error('amountPaise must be a positive integer (paise)');
  }

  const cfg = razorpayConfig();
  if (!cfg.ok) {
    // Callers should pre-check razorpayConfig() and answer 503; this is a guard.
    throw new Error(`Razorpay not configured — missing: ${cfg.missing.join(', ')}`);
  }

  const res = await fetch(`${API_BASE}/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: authHeader(cfg.value.RAZORPAY_KEY_ID, cfg.value.RAZORPAY_KEY_SECRET),
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      // Razorpay requires notes values to be strings; the caller passes strings.
      notes: notes ?? {},
      payment_capture: 1, // auto-capture; a manually-captured order can strand a paid customer
    }),
  });

  if (!res.ok) {
    // Do NOT include the response body verbatim — it can echo request context. A
    // status is enough to diagnose without risking a secret in a log line.
    throw new Error(`Razorpay order creation failed with status ${res.status}`);
  }

  const order = (await res.json()) as RazorpayOrder;
  return order;
}

/**
 * Verify a Razorpay webhook signature.
 *
 * The HMAC is computed over the RAW request body (the exact bytes Razorpay signed)
 * with RAZORPAY_WEBHOOK_SECRET, and compared to the `x-razorpay-signature` header
 * using a constant-time comparison so the endpoint cannot be probed byte-by-byte.
 *
 * An unverified webhook is a free money-printing bug: anyone who can POST to the
 * endpoint could mark an order paid. This must pass before the body is trusted.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;

  const cfg = razorpayConfig();
  if (!cfg.ok) return false;

  const expected = createHmac('sha256', cfg.value.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const givenBuf = Buffer.from(signatureHeader, 'utf8');

  // timingSafeEqual throws on length mismatch; a wrong-length signature is simply
  // invalid, so treat that as false rather than letting it throw.
  if (expectedBuf.length !== givenBuf.length) return false;
  return timingSafeEqual(expectedBuf, givenBuf);
}
