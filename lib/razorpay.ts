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

/** The slice of a Razorpay Refund we read. */
export interface RazorpayRefund {
  id: string;
  entity: 'refund';
  amount: number; // paise
  payment_id: string;
  status: 'pending' | 'processed' | 'failed';
}

/**
 * A refund the API refused. `notSupported` is true when Razorpay says this payment
 * cannot be refunded through it (too old, or the instrument/bank does not support
 * refunds) — the caller parks the refund for a manual UPI payout instead of retrying.
 * `code` is Razorpay's error code; the free-text description is never stored or logged.
 */
export class RazorpayRefundError extends Error {
  constructor(
    public httpStatus: number,
    public code: string,
    public notSupported: boolean,
  ) {
    super(`Razorpay refund failed (${httpStatus}${code ? ` ${code}` : ''})`);
    this.name = 'RazorpayRefundError';
  }
}

export interface CreateRefundInput {
  paymentId: string;
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}

/**
 * POST /v1/payments/{paymentId}/refund — speed 'normal' (instant refunds cost extra
 * and are not part of the published policy). Callers must pre-check razorpayConfig().
 */
export async function createRefund({ paymentId, amountPaise, receipt, notes }: CreateRefundInput): Promise<RazorpayRefund> {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new Error('amountPaise must be a positive integer (paise)');
  }
  if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) throw new Error('not a Razorpay payment id');
  const cfg = razorpayConfig();
  if (!cfg.ok) throw new Error(`Razorpay not configured — missing: ${cfg.missing.join(', ')}`);

  const res = await fetch(`${API_BASE}/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: authHeader(cfg.value.RAZORPAY_KEY_ID, cfg.value.RAZORPAY_KEY_SECRET),
    },
    body: JSON.stringify({ amount: amountPaise, speed: 'normal', receipt, notes: notes ?? {} }),
  });

  if (!res.ok) {
    let code = '';
    let description = '';
    try {
      const body = (await res.json()) as { error?: { code?: unknown; description?: unknown } };
      code = typeof body.error?.code === 'string' ? body.error.code : '';
      description = typeof body.error?.description === 'string' ? body.error.description : '';
    } catch {
      // non-JSON error body — the status alone classifies it
    }
    // Classified from the description, never stored: Razorpay phrases these as
    // "...not supported..." / "...older than 6 months..." / "...cannot be refunded...".
    const notSupported =
      res.status === 400 && /not supported|older than|cannot be refunded|not eligible/i.test(description);
    throw new RazorpayRefundError(res.status, code, notSupported);
  }
  return (await res.json()) as RazorpayRefund;
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

/**
 * Verify the signature Razorpay Checkout hands back to the BROWSER on success.
 *
 * This is a DIFFERENT computation from verifyWebhookSignature, and conflating them
 * is a real trap:
 *
 *   webhook   HMAC_SHA256( raw request body , RAZORPAY_WEBHOOK_SECRET )
 *   handshake HMAC_SHA256( "<order_id>|<payment_id>" , RAZORPAY_KEY_SECRET )
 *
 * Different message, different key. Checking the handshake with the webhook secret
 * fails every time; checking it with the wrong message shape fails silently in the
 * same way.
 *
 * Why this exists at all: the webhook was the only fulfilment path, and Razorpay
 * cannot reach a loopback address, so locally a paid order never became a
 * subscription. It is also the right thing in production — the handshake confirms
 * the payment synchronously so the customer sees their subscription immediately,
 * while the webhook remains the durable backstop for a closed tab. Both funnel
 * through the same guarded state transition, so whichever arrives first wins and
 * the second is a no-op.
 */
export function verifyPaymentSignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  signature: string | null,
): boolean {
  if (!signature || !razorpayOrderId || !razorpayPaymentId) return false;

  const cfg = razorpayConfig();
  if (!cfg.ok) return false;

  const expected = createHmac('sha256', cfg.value.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const givenBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== givenBuf.length) return false;
  return timingSafeEqual(expectedBuf, givenBuf);
}
