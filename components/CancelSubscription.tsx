'use client';

import { useState } from 'react';

/**
 * Cancel control for one subscription, on the account page.
 *
 * Cancelling is irreversible and stops future deliveries, so it asks for an
 * explicit confirmation before calling the API, and on success reloads so the page
 * re-renders the subscription as cancelled. The refund itself is not handled here —
 * it follows the published cancellation policy, which the copy links to.
 */
export function CancelSubscription({ subscriptionId }: { subscriptionId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    if (
      !window.confirm(
        'Cancel this subscription? Future deliveries stop immediately and any eligible ' +
          'refund follows our cancellation policy. This cannot be undone.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/subscriptions/${subscriptionId}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Could not cancel the subscription.');
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel the subscription.');
      setBusy(false);
    }
  };

  return (
    <div className="sub-cancel">
      {error && <p className="sub-cancel-err">{error}</p>}
      <button type="button" className="sub-cancel-btn" onClick={cancel} disabled={busy}>
        {busy ? 'Cancelling…' : 'Cancel subscription'}
      </button>
      <p className="sub-cancel-note">
        Stops future deliveries. Refunds follow our{' '}
        <a href="/legal/refunds">cancellation &amp; refund policy</a>.
      </p>
    </div>
  );
}
