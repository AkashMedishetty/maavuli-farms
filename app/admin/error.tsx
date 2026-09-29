'use client';

/** Last-resort boundary: a screen threw while rendering. Never an empty state. */
export default function AdminError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="ops-error" role="alert" style={{ marginTop: '1rem' }}>
      <strong>This screen failed to load.</strong> Nothing here is live data right now.
      <div className="ops-actions">
        <button type="button" className="ops-btn" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
