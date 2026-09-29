import './account.css';

/** Shown while the account view loads — a loading state, never an empty one. */
export default function AccountLoading() {
  return (
    <main className="acct" aria-busy="true">
      <header className="acct-head">
        <p className="acct-eyebrow">My deliveries</p>
        <h1>Loading your deliveries…</h1>
      </header>
      <section className="acct-card acct-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </section>
      <section className="acct-card acct-skeleton" aria-hidden="true">
        <span />
        <span />
      </section>
    </main>
  );
}
