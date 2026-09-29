'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Script from 'next/script';

/**
 * Razorpay checkout, loaded lazily.
 *
 * How payment is CONFIRMED: the parent posts the handler's response to
 * `POST /api/payments/verify` (HMAC re-checked server-side, same guarded
 * transition as the webhook). The Razorpay webhook is the durable backstop, so a
 * verify call that fails after money moved is reported as "payment received —
 * confirming", never as a failure.
 *
 * `order` is exactly the `razorpay` object `POST /api/checkout` returns:
 * { orderId, keyId, amountPaise } — amountPaise is what Razorpay charges (the
 * payable part after any credit), never a client-computed number.
 *
 * Test mode: keyId starting with "rzp_test_" shows a test-mode note.
 */

interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  order_id: string;
  prefill?: { contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler: (r: RazorpayResponse) => void;
  modal?: { ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
  on: (event: string, cb: (e: unknown) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

export interface CheckoutOrder {
  /** Razorpay order id */
  orderId: string;
  keyId: string;
  /** payable amount in paise, as created server-side */
  amountPaise: number;
}

export type { RazorpayResponse };

export default function RazorpayCheckout({
  order,
  mobile,
  planLabel,
  onPaid,
  onError,
  label = 'Pay & start delivery',
}: {
  order: CheckoutOrder;
  mobile: string;
  planLabel: string;
  /** Button copy once the script is ready (extra-milk payments start nothing). */
  label?: string;
  /** Razorpay reported success. The parent confirms via /api/payments/verify. */
  onPaid: (r: RazorpayResponse) => void;
  onError: (message: string) => void;
}) {
  const [scriptReady, setScriptReady] = useState(false);
  const [opening, setOpening] = useState(false);
  const openedRef = useRef(false);

  const isTest = order.keyId.startsWith('rzp_test_');

  // A second checkout in the same page session: the script is already loaded, and
  // next/script's onLoad does not fire again — read it from window instead.
  useEffect(() => {
    if (window.Razorpay) setScriptReady(true);
  }, []);

  const open = useCallback(() => {
    if (!window.Razorpay) {
      onError('The payment window could not load. Check your connection and try again.');
      return;
    }
    setOpening(true);
    openedRef.current = true;
    try {
      const rzp = new window.Razorpay({
        key: order.keyId,
        amount: order.amountPaise,
        currency: 'INR',
        name: 'Maavuli Farm Milk',
        description: planLabel,
        order_id: order.orderId,
        prefill: { contact: mobile },
        theme: { color: '#8c170e' },
        handler: (r) => {
          setOpening(false);
          onPaid(r);
        },
        modal: {
          ondismiss: () => setOpening(false),
        },
      });
      rzp.on('payment.failed', () => {
        setOpening(false);
        onError('The payment did not go through. No money was taken — you can try again.');
      });
      rzp.open();
    } catch {
      setOpening(false);
      onError('Could not open the payment window. Please try again.');
    }
  }, [order, mobile, planLabel, onPaid, onError]);

  // Auto-open once the script is ready, so the flow feels continuous after the
  // order is created. Guarded so it fires exactly once.
  useEffect(() => {
    if (scriptReady && !openedRef.current) open();
  }, [scriptReady, open]);

  return (
    <>
      <Script
        src="https://checkout.razorpay.com/v1/checkout.js"
        strategy="lazyOnload"
        onLoad={() => setScriptReady(true)}
        onReady={() => setScriptReady(true)}
        onError={() =>
          onError('The payment window could not load. Check your connection and try again.')
        }
      />
      {isTest && (
        <span className="sb-testmode" role="note">
          Test mode — no real money moves
        </span>
      )}
      <button
        type="button"
        className={`sb-btn${opening ? ' is-busy' : ''}`}
        onClick={open}
        disabled={opening}
        aria-live="polite"
      >
        {opening ? (
          <>
            <span className="sb-spinner" aria-hidden="true" /> Opening payment…
          </>
        ) : scriptReady ? (
          label
        ) : (
          'Loading payment…'
        )}
      </button>
    </>
  );
}
