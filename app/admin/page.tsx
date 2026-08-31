import ZoneMap from '@/components/ZoneMap';
import Link from 'next/link';
import { NotConfiguredError } from '@/lib/db';
import { formatINR } from '@/lib/pricing';
import {
  requireAdmin,
  NotAdminError,
  adminConfigured,
  todaysRound,
  activeSubscriptions,
  revenueSummary,
  type TodaysRound,
  type ActiveSubscriptionRow,
  type RevenueSummary,
} from '@/lib/admin';

export const dynamic = 'force-dynamic';

/**
 * The fulfilment panel — the highest-value screen in the build, and the one thing
 * that turns "read Razorpay at 5am and write on paper" into a real morning round.
 *
 * Server component: the auth check runs on the server before anything renders.
 * There is no client-side gate and no query-parameter gate — an unauthenticated
 * caller sees the "not authorised" state and no data ever leaves the server.
 */

/** YYYY-MM-DD for "today" in Asia/Kolkata — a round is a local-calendar concept. */
function todayIST(): string {
  // en-CA yields YYYY-MM-DD; the timeZone makes it the IST calendar day
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function kindLabel(kind: 'buffalo' | 'cow'): string {
  return kind === 'cow' ? 'Cow' : 'Buffalo';
}

function litres(n: number): string {
  // 0.5 stays "0.5 L", 2 stays "2 L"
  return `${Number.isInteger(n) ? n : n.toFixed(1)} L`;
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  // 1) Empty allowlist => admin is UNREACHABLE. Say so plainly, render no panel.
  if (!adminConfigured()) {
    return (
      <main className="page">
        <header className="page-head">
          <p className="eyebrow">Admin</p>
          <h1>Admin is not configured.</h1>
          <p>
            No admin mobile numbers are set, so this panel is intentionally
            unreachable. Set <code>ADMIN_MOBILES</code> (comma-separated 10-digit
            numbers) in the environment to enable it.
          </p>
        </header>
      </main>
    );
  }

  // 2) Server-side allowlist check. requireAdmin throws unless the session's mobile
  //    is in ADMIN_MOBILES.
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdminError) {
      return (
        <main className="page">
          <header className="page-head">
            <p className="eyebrow">Admin</p>
            <h1>Not authorised.</h1>
            <p>
              This panel is restricted to farm staff. Sign in with an admin mobile
              number to continue.
            </p>
            <Link className="cta" href="/account">
              Sign in
            </Link>
          </header>
        </main>
      );
    }
    throw err;
  }

  const params = await searchParams;
  const date = params.date && DATE_RE.test(params.date) ? params.date : todayIST();

  // 3) Load the round, roster and revenue. If the DB is unreachable, say so — never
  //    render empty panels that imply "nothing scheduled today".
  let round: TodaysRound | null = null;
  let subs: ActiveSubscriptionRow[] = [];
  let revenue: RevenueSummary | null = null;
  let dbError: string | null = null;

  try {
    [round, subs, revenue] = await Promise.all([
      todaysRound(date),
      activeSubscriptions(),
      revenueSummary(),
    ]);
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      dbError = `Database not configured — missing ${err.missing.join(', ')}.`;
    } else {
      dbError =
        'The database is not reachable, so the round could not be loaded. ' +
        'This panel is not showing live data right now.';
    }
  }

  return (
    <main className="page admin">
      <header className="page-head">
        <p className="eyebrow">Admin · fulfilment</p>
        <h1>Morning round</h1>
        <p>Who gets what, in which pincode, on the chosen day.</p>

        {/* GET form: picking a date reloads the server-rendered round. No JS. */}
        <form className="admin-datebar" method="get">
          <label htmlFor="date">Round date</label>
          <input type="date" id="date" name="date" defaultValue={date} />
          <button className="cta" type="submit">
            View day
          </button>
        </form>
      </header>

      {dbError && (
        <section className="panel admin-alert">
          <p>{dbError}</p>
        </section>
      )}

      {/* ---- primary view: the round, pincode-grouped, litres totalled ---- */}
      {!dbError && <ZoneMap />}

      {!dbError && round && (
        <section className="admin-round">
          <div className="admin-round-head">
            <h2>Round for {date}</h2>
            <p className="admin-grandtotal">
              <strong>{litres(round.litresTotal)}</strong> total across{' '}
              {round.pincodes.length} pincode{round.pincodes.length === 1 ? '' : 's'}
            </p>
          </div>

          {round.pincodes.length === 0 ? (
            <p className="pending">No deliveries scheduled for {date}.</p>
          ) : (
            round.pincodes.map(group => (
              <div key={group.pincode} className="panel admin-pincode">
                <div className="admin-pincode-head">
                  <h3>{group.pincode}</h3>
                  <span className="admin-pincode-total">{litres(group.litresTotal)}</span>
                </div>
                <div className="plan-table">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Mobile</th>
                        <th scope="col">Milk</th>
                        <th scope="col">Litres</th>
                        <th scope="col">Status</th>
                        <th scope="col">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.deliveries.map(d => (
                        <tr key={d.deliveryId}>
                          <th scope="row">{d.mobile}</th>
                          <td>{kindLabel(d.kind)}</td>
                          <td>{litres(d.litres)}</td>
                          <td>
                            <span className={`admin-status is-${d.status}`}>{d.status}</span>
                          </td>
                          <td>{d.note ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
          <p className="admin-hint">
            Deliveries are marked delivered / skipped / failed by{' '}
            <code>POST /api/admin/delivery</code>. Inline actions are a follow-up —
            the client has not confirmed a mark-off flow yet.
          </p>
        </section>
      )}

      {/* ---- active subscriptions ---- */}
      {!dbError && (
        <section className="admin-section">
          <h2>Active subscriptions</h2>
          {subs.length === 0 ? (
            <p className="pending">No active subscriptions.</p>
          ) : (
            <div className="plan-table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Mobile</th>
                    <th scope="col">Milk</th>
                    <th scope="col">Per day</th>
                    <th scope="col">Pincode</th>
                    <th scope="col">Window</th>
                    <th scope="col">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {subs.map(s => (
                    <tr key={s.subscriptionId}>
                      <th scope="row">{s.mobile}</th>
                      <td>{kindLabel(s.kind)}</td>
                      <td>{litres(s.litresPerDay)}</td>
                      <td>{s.pincode}</td>
                      <td>
                        {s.startDate} → {s.endDate}
                      </td>
                      <td>
                        {s.daysDelivered} / {s.daysTotal} days
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ---- paid-orders total (stored paise, never re-derived) ---- */}
      {!dbError && revenue && (
        <section className="admin-section">
          <h2>Revenue</h2>
          <div className="panel admin-revenue">
            <p className="admin-revenue-total">
              <strong>{formatINR(revenue.totalPaise)}</strong>
            </p>
            <p className="admin-revenue-note">
              across {revenue.paidOrders} paid order{revenue.paidOrders === 1 ? '' : 's'} —
              summed from the amount stored on each order at purchase time.
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
