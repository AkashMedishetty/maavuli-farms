import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import '../../crm.css';
import { canOperate, loadErrorMessage, pageStaff } from '@/lib/admin';
import { customerDetail, GOODWILL_CAP_PAISE, actorLabel, type CustomerDetail, type PlanView } from '@/lib/admin-customers';
import { normalizeMobile } from '@/lib/models';
import { formatINR } from '@/lib/pricing';
import { LoadError, pageCtx } from '@/components/admin/ops/server';
import { dateTimeLabel, litres, milkLabel, reasonLabel, statusLabel, ymdLabel } from '@/components/admin/ops/format';
import { CREDIT_KIND, MESSAGE_STATUS, ORDER_STATUS, PLAN_STATUS, REFUND_STATUS, TICKET_KIND, badge, telHref } from '@/components/admin/crm/labels';
import Breakdown from '@/components/admin/crm/Breakdown';
import CancelPlan from '@/components/admin/crm/CancelPlan';
import PausePlan from '@/components/admin/crm/PausePlan';
import GoodwillCredit from '@/components/admin/crm/GoodwillCredit';
import WhatsappOptOut from '@/components/admin/crm/WhatsappOptOut';
import ResolveTicket from '@/components/admin/crm/ResolveTicket';

export const dynamic = 'force-dynamic';

function Money({ paise }: { paise: number }) {
  return <span className={paise < 0 ? 'crm-money-neg' : 'crm-money-pos'}>{paise < 0 ? `−${formatINR(-paise)}` : `+${formatINR(paise)}`}</span>;
}

function Plan({ plan, mobile, operate }: { plan: PlanView; mobile: string; operate: boolean }) {
  const b = badge(PLAN_STATUS, plan.status);
  const live = plan.status === 'active' || plan.status === 'scheduled';
  const remaining = Math.max(0, plan.pauseAllowanceDays - plan.pauseUsedDays);
  return (
    <li>
      <div className="ops-card-head">
        <h3>{plan.label}</h3>
        <span className={`ops-badge ${b.tone}`}>{b.label}</span>
      </div>
      <dl className="ops-kv" style={{ margin: '0.4rem 0' }}>
        <dt>Dates</dt>
        <dd>
          {ymdLabel(plan.startDate)} → {ymdLabel(plan.endDate)}
        </dd>
        <dt>Delivered</dt>
        <dd>
          {plan.daysDelivered} of {plan.daysTotal} days
        </dd>
        <dt>Pauses</dt>
        <dd>
          {plan.pauseUsedDays} of {plan.pauseAllowanceDays} used
          {plan.pausedDates.length ? ` · upcoming: ${plan.pausedDates.map(ymdLabel).join(', ')}` : ''}
        </dd>
        <dt>Deliver to</dt>
        <dd>
          {plan.name ? `${plan.name}, ` : ''}
          {plan.address ?? 'No address on the plan'}
          {plan.landmark ? ` (${plan.landmark})` : ''}
          {plan.location && (
            <>
              {' · '}
              <a href={`https://www.google.com/maps/search/?api=1&query=${plan.location.lat},${plan.location.lng}`} target="_blank" rel="noopener noreferrer">
                Pin on map
              </a>
            </>
          )}
        </dd>
        {plan.instructions && (
          <>
            <dt>Instructions</dt>
            <dd>{plan.instructions}</dd>
          </>
        )}
        {(plan.renewedBy || plan.renewalOf) && (
          <>
            <dt>Renewal</dt>
            <dd>{plan.renewedBy ? 'A renewal is queued after this plan' : 'This plan renews an earlier one'}</dd>
          </>
        )}
        {plan.status === 'cancelled' && (
          <>
            <dt>Cancelled</dt>
            <dd>
              {plan.cancelledAt ? dateTimeLabel(plan.cancelledAt) : '—'}
              {plan.cancelEffectiveDate ? ` · no deliveries from ${ymdLabel(plan.cancelEffectiveDate)}` : ''}
              {plan.cancelledBy ? ` · by ${actorLabel(plan.cancelledBy)}` : ''}
              {plan.cancelReason ? ` · “${plan.cancelReason}”` : ''}
            </dd>
          </>
        )}
      </dl>
      {live &&
        (operate ? (
          <div className="ops-actions">
            <PausePlan mobile={mobile} subscriptionId={plan.id} dates={plan.pausableDates} remaining={remaining} />
            <CancelPlan mobile={mobile} subscriptionId={plan.id} />
          </div>
        ) : (
          <p className="ops-muted">Read-only: an owner or ops lead can pause or cancel on the customer&apos;s behalf.</p>
        ))}
      {live && operate && plan.pausableDates.length === 0 && <p className="ops-muted">No open planned dates to pause.</p>}
      {live && operate && remaining === 0 && plan.pausableDates.length > 0 && <p className="ops-muted">The pause allowance is used up.</p>}
    </li>
  );
}

function Section({ id, title, count, children }: { id: string; title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="ops-card" id={id} aria-labelledby={`${id}-h`}>
      <div className="ops-card-head">
        <h2 id={`${id}-h`}>{title}</h2>
        {count !== undefined && <span className="ops-badge">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function Body({ c, operate, capPaise }: { c: CustomerDetail; operate: boolean; capPaise: number }) {
  const pr = c.profile;
  return (
    <>
      <nav className="crm-jump" aria-label="Sections">
        <a href="#plans">Plans</a>
        <a href="#credit">Credit</a>
        <a href="#deliveries">Deliveries</a>
        <a href="#orders">Orders</a>
        <a href="#refunds">Refunds</a>
        <a href="#tickets">Issues</a>
        <a href="#messages">Messages</a>
        <a href="#timeline">Timeline</a>
      </nav>

      <Section id="profile" title="Profile">
        {!pr.exists && <p className="ops-warn">No account row yet (they have orders or plans only).</p>}
        <dl className="ops-kv">
          <dt>Mobile</dt>
          <dd>
            <a href={telHref(c.mobile)}>{c.mobile}</a> · <a href={`https://wa.me/91${c.mobile}`} target="_blank" rel="noopener noreferrer">WhatsApp chat</a>
          </dd>
          {pr.email && (
            <>
              <dt>Email</dt>
              <dd>{pr.email}</dd>
            </>
          )}
          <dt>Address</dt>
          <dd>
            {pr.address ?? '—'}
            {pr.landmark ? ` (${pr.landmark})` : ''}
          </dd>
          <dt>Language</dt>
          <dd>{pr.lang === 'te' ? 'Telugu' : 'English'}</dd>
          <dt>WhatsApp</dt>
          <dd>{pr.whatsappOptIn ? `On${pr.whatsappOptInAt ? ` since ${dateTimeLabel(pr.whatsappOptInAt)}` : ''}` : 'Off — no messages are sent'}</dd>
          <dt>If we miss a day</dt>
          <dd>{pr.missedDeliveryPreference === 'credit' ? 'Keep the value as credit' : 'Add a make-up day at the end'}</dd>
          <dt>Daily photo</dt>
          <dd>{pr.notifyDailyDelivered ? 'Yes, a WhatsApp every delivered morning' : 'No'}</dd>
          <dt>Customer since</dt>
          <dd>{pr.createdAt ? dateTimeLabel(pr.createdAt) : '—'}</dd>
          <dt>Last seen</dt>
          <dd>{pr.lastSeenAt ? dateTimeLabel(pr.lastSeenAt) : '—'}</dd>
        </dl>
        {pr.exists && pr.whatsappOptIn && (
          <div className="ops-actions">
            <WhatsappOptOut mobile={c.mobile} />
          </div>
        )}
      </Section>

      <Section id="plans" title="Plans" count={c.plans.length}>
        <p className="ops-muted">Changes apply from {ymdLabel(c.firstOpenDate)} (the first date still open).</p>
        {c.plans.length === 0 ? <p className="ops-empty">No plans.</p> : <ul className="ops-list">{c.plans.map(pl => <Plan key={pl.id} plan={pl} mobile={c.mobile} operate={operate} />)}</ul>}
      </Section>

      <Section id="credit" title="Credit">
        <p>
          Balance <strong>{formatINR(c.credit.balancePaise)}</strong>
          {c.credit.refundablePaise > 0 ? ` · of which ${formatINR(c.credit.refundablePaise)} refundable (missed days)` : ''}
        </p>
        {pr.exists ? <GoodwillCredit mobile={c.mobile} capPaise={capPaise} /> : <p className="ops-muted">Credit needs an account row.</p>}
        {c.credit.history.length === 0 ? (
          <p className="ops-empty">No credit entries.</p>
        ) : (
          <div className="ops-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col" className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {c.credit.history.map(h => (
                  <tr key={h.id}>
                    <td>{dateTimeLabel(h.at)}</td>
                    <td>
                      {CREDIT_KIND[h.kind] ?? h.kind}
                      {h.refundable ? ' (refundable)' : ''}
                      {h.note ? ` — ${h.note}` : ''}
                      <br />
                      <span className="ops-muted">{actorLabel(h.actor)}</span>
                    </td>
                    <td className="num">
                      <Money paise={h.amountPaise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="deliveries" title="Last 60 deliveries" count={c.deliveries.length}>
        {c.deliveries.length === 0 ? (
          <p className="ops-empty">No deliveries yet.</p>
        ) : (
          <ul className="ops-list crm-deliveries">
            {c.deliveries.map(d => (
              <li key={d.id}>
                {d.photoUrl ? (
                  <a href={d.photoUrl} target="_blank" rel="noopener noreferrer" aria-label={`Doorstep photo, ${ymdLabel(d.date)}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- private, access-checked photo route */}
                    <img className="crm-thumb" src={d.photoUrl} alt="" loading="lazy" />
                  </a>
                ) : null}
                <div>
                  <strong>{ymdLabel(d.date)}</strong> <span className={`ops-badge is-${d.status}`}>{statusLabel(d.status)}</span>
                  {d.flagged && <span className="ops-badge is-warn">Proof flagged</span>}
                  <br />
                  {milkLabel(d.kind)} {litres(d.litres)}
                  {d.source !== 'plan' ? ` (${d.source === 'makeup' ? 'make-up' : 'extra'})` : ''}
                  {d.deliveredAt ? ` · ${dateTimeLabel(d.deliveredAt)}` : ''}
                  {d.reason && (
                    <>
                      <br />
                      {reasonLabel(d.reason)}
                      {d.reasonNote ? ` — “${d.reasonNote}”` : ''}
                      {d.fault ? ` · fault: ${d.fault === 'ours' ? 'ours' : d.fault === 'customer' ? 'customer' : 'undecided'}` : ''}
                      {d.resolution && d.resolution !== 'none' ? ` · made good by ${d.resolution === 'credit' ? 'credit' : 'a make-up day'}` : ''}
                    </>
                  )}
                  {d.note && (
                    <>
                      <br />
                      <span className="ops-muted">{d.note}</span>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="orders" title="Orders" count={c.orders.length}>
        {c.orders.length === 0 ? (
          <p className="ops-empty">No orders.</p>
        ) : (
          <ul className="ops-list">
            {c.orders.map(o => {
              const b = badge(ORDER_STATUS, o.status);
              return (
                <li key={o.id}>
                  <strong>{o.plan}</strong> <span className={`ops-badge ${b.tone}`}>{b.label}</span>
                  <br />
                  {formatINR(o.amountPaise)}
                  {o.creditAppliedPaise ? ` (${formatINR(o.creditAppliedPaise)} from credit)` : ''}
                  {o.refundedPaise ? ` · ${formatINR(o.refundedPaise)} refunded` : ''} · {dateTimeLabel(o.paidAt ?? o.createdAt)}
                  {o.purpose === 'renewal' ? ' · renewal' : ''}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section id="refunds" title="Refunds" count={c.refunds.length}>
        {c.refunds.length === 0 ? (
          <p className="ops-empty">No refunds.</p>
        ) : (
          <ul className="ops-list">
            {c.refunds.map(r => {
              const b = badge(REFUND_STATUS, r.status);
              return (
                <li key={r.id}>
                  <strong>{formatINR(r.amountPaise)}</strong> <span className={`ops-badge ${b.tone}`}>{b.label}</span> · {dateTimeLabel(r.createdAt)}
                  {r.failureReason && <p className="ops-muted">{r.failureReason}</p>}
                  <Breakdown b={r.breakdown} />
                  <Link href={`/admin/refunds?status=${r.status}`}>Open in the refunds queue</Link>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section id="tickets" title="Issues" count={c.tickets.length}>
        {c.tickets.length === 0 ? (
          <p className="ops-empty">No issues reported.</p>
        ) : (
          <ul className="ops-list">
            {c.tickets.map(t => (
              <li key={t.id}>
                <strong>{TICKET_KIND[t.kind] ?? t.kind}</strong>{' '}
                <span className={`ops-badge ${t.status === 'open' ? 'is-warn' : 'is-ok'}`}>{t.status === 'open' ? 'Open' : 'Resolved'}</span> ·{' '}
                {dateTimeLabel(t.createdAt)} · via {t.channel}
                {t.note && <p>{t.note}</p>}
                {t.photoUrl && (
                  <a href={t.photoUrl} target="_blank" rel="noopener noreferrer">
                    Photo
                  </a>
                )}
                {t.resolution && <p className="ops-muted">Resolution: {t.resolution}</p>}
                {t.status === 'open' && <ResolveTicket ticketId={t.id} />}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="messages" title="WhatsApp messages" count={c.messages.length}>
        {c.messages.length === 0 ? (
          <p className="ops-empty">No messages.</p>
        ) : (
          <ul className="ops-list">
            {c.messages.map(m => {
              const b = badge(MESSAGE_STATUS, m.status);
              return (
                <li key={m.id}>
                  <code>{m.template}</code> <span className={`ops-badge ${b.tone}`}>{b.label}</span> · {dateTimeLabel(m.createdAt)}
                  {m.text ? <p className="crm-msg">{m.text}</p> : <p className="ops-muted">(text could not be rendered)</p>}
                  {m.error && <p className="ops-muted">Error: {m.error}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section id="timeline" title="Timeline" count={c.timeline.length}>
        {c.timeline.length === 0 ? (
          <p className="ops-empty">No recorded events.</p>
        ) : (
          <ol className="crm-timeline">
            {c.timeline.map(e => (
              <li key={e.id}>
                <time dateTime={e.at}>{dateTimeLabel(e.at)}</time>
                <strong>{e.label}</strong>
                {e.detail ? ` — ${e.detail}` : ''}
                <span className="ops-muted"> · {e.who}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}

export default async function AdminCustomerPage({ params }: { params: Promise<{ mobile: string }> }) {
  const p = await pageStaff();
  if (!p) return null;
  const { mobile: raw } = await params;
  const mobile = normalizeMobile(decodeURIComponent(raw));
  if (!mobile) notFound();
  if (mobile !== raw) redirect(`/admin/customers/${mobile}`);

  const ctx = await pageCtx(p);
  let c: CustomerDetail | null = null;
  let error: string | null = null;
  try {
    c = await customerDetail(mobile, ctx);
  } catch (err) {
    error = loadErrorMessage(err);
  }
  if (!error && !c) notFound();

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">
          <Link href="/admin/customers">Customers</Link>
        </p>
        <h1>{c?.profile.name ?? mobile}</h1>
        <p className="ops-sub">
          <a href={telHref(mobile)}>Call {mobile}</a>
        </p>
      </header>
      {error || !c ? (
        <LoadError what="this customer" message={error ?? 'Unknown error.'} />
      ) : (
        <Body c={c} operate={canOperate(p.staffRole)} capPaise={GOODWILL_CAP_PAISE[p.staffRole]} />
      )}
    </>
  );
}
