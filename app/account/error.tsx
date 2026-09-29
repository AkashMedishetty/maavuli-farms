'use client';

import './account.css';

/** Unexpected failure rendering /account. Says so plainly and offers a retry. */
export default function AccountError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="acct">
      <header className="acct-head">
        <p className="acct-eyebrow">My deliveries</p>
        <h1>Something went wrong.</h1>
      </header>
      <section className="acct-card">
        <p>
          We could not load your account just now. Your plan and deliveries are not affected. Please try again in a
          moment.
        </p>
        <button type="button" className="acct-btn" onClick={() => reset()}>
          Try again
        </button>
      </section>
    </main>
  );
}
