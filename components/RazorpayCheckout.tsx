'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Script from 'next/script';

/**
 * Razorpay checkout, loaded lazily.
 *
 * IMPORTANT — how payment is CONFIRMED here:
 *
 * There is no browser-callable "verify" route in this codebase. Activation is
 * webhook-only: `POST /api/webhooks/razorpay` verifies the HMAC server-to-server
 * and calls `activateSubscriptionForOrder` (see app/api/webhooks/razorpay/route.ts).
 * A browser cannot POST there — it does not hold RAZORPAY_WEBHOOK_SECRET, and it
 * MUST NOT, or the whole signature check is pointless.
 *
 * So the honest client contract is: create the Order (server recomputes the
 * price), open Razorpay, and on the success handler report "payment received — we
 * are confirming it" and send the user to /account, where the webhook-activated
 * subscription appears. We do NOT claim the subscription is live from the browser
 * response alone; the webhook is the source of truth. This gap is flagged in the
 * agent's report.
 *
 * Test mode: if keyId starts with "rzp_test_", the parent shows a test-mode banner.
 * If no order/keyId is available (payments unconfigured -> 503), the parent renders
 * a visibly DISABLED pay button with a plain explanation instead of this component.
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
  razorpayOrderId: string;
  amountPaise: number;
  keyId: string;
}

export default function RazorpayCheckout({
  order,
  mobile,
  planLabel,
  onPaid,
  onError,
}: {
  order: CheckoutOrder;
  mobile: string;
  planLabel: string;
  /** Called when Razorpay reports a successful payment. The subscription is
   *  activated by the webhook, not here — treat this as "payment received". */
  onPaid: (r: RazorpayResponse) => void;
  onError: (message: string) => void;
}) {
  const [scriptReady, setScriptReady] = useState(false);
  const [opening, setOpening] = useState(false);
  const openedRef = useRef(false);

  const isTest = order.keyId.startsWith('rzp_test_');

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
        order_id: order.razorpayOrderId,
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
          'Pay & start delivery'
        ) : (
          'Loading payment…'
        )}
      </button>
    </>
  );
}
