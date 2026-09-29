import Link from 'next/link';
import '../crm.css';
import { loadErrorMessage, pageStaff } from '@/lib/admin';
import { listOutbox, MESSAGE_STATUSES, toTicketView, type MessageView, type TicketView } from '@/lib/admin-customers';
import { listTickets } from '@/lib/tickets';
import { normalizeMobile, type MessageStatus } from '@/lib/models';
import { TEMPLATES } from '@/lib/notify/templates';
import { LoadError } from '@/components/admin/ops/server';
import { dateTimeLabel } from '@/components/admin/ops/format';
import { MESSAGE_STATUS, TICKET_KIND, badge, telHref } from '@/components/admin/crm/labels';
import ResolveTicket from '@/components/admin/crm/ResolveTicket';

export const dynamic = 'force-dynamic';

type SP = { tab?: string; status?: string; template?: string; mobile?: string; cursor?: string };

function qs(sp: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

function Tickets({ rows }: { rows: TicketView[] }) {
  if (!rows.length) return <p className="ops-empty">No issues with this status.</p>;
  return (
    <section className="ops-card" aria-label="Issues">
      <ul className="ops-list">
        {rows.map(t => (
          <li key={t.id}>
            <div className="ops-card-head">
              <h3>{TICKET_KIND[t.kind] ?? t.kind}</h3>
              <span className={`ops-badge ${t.status === 'open' ? 'is-warn' : 'is-ok'}`}>{t.status === 'open' ? 'Open' : 'Resolved'}</span>
            </div>
            <p className="crm-row-meta" style={{ margin: '0.2rem 0' }}>
              <a href={telHref(t.mobile)}>{t.mobile}</a> · <Link href={`/admin/customers/${t.mobile}`}>Customer</Link> · {dateTimeLabel(t.createdAt)} · via{' '}
              {t.channel}
            </p>
            {t.note && <p>{t.note}</p>}
            {t.photoUrl && (
              <a href={t.photoUrl} target="_blank" rel="noopener noreferrer">
                Photo from the customer
              </a>
            )}
            {t.resolution && <p className="ops-muted">Resolution: {t.resolution}</p>}
            {t.status === 'open' && <ResolveTicket ticketId={t.id} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Outbox({ rows, nextHref }: { rows: MessageView[]; nextHref: string | null }) {
  if (!rows.length) return <p className="ops-empty">No messages match these filters.</p>;
  return (
    <section className="ops-card" aria-label="Outbox">
      <ul className="ops-list">
        {rows.map(m => {
          const b = badge(MESSAGE_STATUS, m.status);
          return (
            <li key={m.id}>
              <div className="ops-card-head">
                <strong>
                  <code>{m.template}</code> → <Link href={`/admin/customers/${m.mobile}`}>{m.mobile}</Link>
                </strong>
                <span className={`ops-badge ${b.tone}`}>{b.label}</span>
              </div>
              <p className="crm-row-meta" style={{ margin: '0.2rem 0' }}>
                {dateTimeLabel(m.createdAt)} · {m.lang === 'te' ? 'Telugu' : 'English'}
                {m.attempts > 1 ? ` · ${m.attempts} attempts` : ''}
                {m.updatedAt !== m.createdAt ? ` · last update ${dateTimeLabel(m.updatedAt)}` : ''}
              </p>
              {m.text ? <p className="crm-msg">{m.text}</p> : <p className="ops-muted">(text could not be rendered)</p>}
              {m.mediaUrl && <p className="ops-muted">With an image.</p>}
              {m.error && <p className="ops-warn">Error: {m.error}</p>}
            </li>
          );
        })}
      </ul>
      {nextHref && (
        <div className="ops-actions">
          <Link className="ops-btn" href={nextHref}>
            Older messages
          </Link>
        </div>
      )}
    </section>
  );
}

export default async function AdminMessagesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const p = await pageStaff();
  if (!p) return null;
  const sp = await searchParams;
  const tab = sp.tab === 'outbox' ? 'outbox' : 'tickets';

  let tickets: TicketView[] | null = null;
  let outbox: { messages: MessageView[]; nextCursor: string | null } | null = null;
  let error: string | null = null;
  let bad: string | null = null;

  const ticketStatus = sp.status === 'resolved' ? 'resolved' : sp.status === 'all' ? undefined : 'open';
  const msgStatus = MESSAGE_STATUSES.find(s => s === sp.status) as MessageStatus | undefined;
  const template = sp.template && Object.prototype.hasOwnProperty.call(TEMPLATES, sp.template) ? sp.template : undefined;
  const mobile = sp.mobile ? normalizeMobile(sp.mobile) : null;
  if (sp.mobile && !mobile) bad = 'That mobile number is not valid, so it was ignored.';
  const cursor = sp.cursor && /^[a-f0-9]{24}$/i.test(sp.cursor) ? sp.cursor : undefined;

  try {
    if (tab === 'tickets') {
      tickets = (await listTickets({ ...(ticketStatus ? { status: ticketStatus } : {}), ...(mobile ? { mobile } : {}) })).map(toTicketView);
    } else {
      outbox = await listOutbox({
        ...(msgStatus ? { status: msgStatus } : {}),
        ...(template ? { template } : {}),
        ...(mobile ? { mobile } : {}),
        ...(cursor ? { cursor } : {}),
      });
    }
  } catch (err) {
    error = loadErrorMessage(err);
  }

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Messages</p>
        <h1>{tab === 'tickets' ? 'Customer issues' : 'WhatsApp outbox'}</h1>
        <nav aria-label="Messages">
          <ul className="crm-tabs">
            <li>
              <Link href="/admin/messages?tab=tickets" aria-current={tab === 'tickets' ? 'page' : undefined}>
                Issues
              </Link>
            </li>
            <li>
              <Link href="/admin/messages?tab=outbox" aria-current={tab === 'outbox' ? 'page' : undefined}>
                Outbox
              </Link>
            </li>
          </ul>
        </nav>
        <form className="crm-filters" method="get">
          <input type="hidden" name="tab" value={tab} />
          <label>
            Status
            {tab === 'tickets' ? (
              <select name="status" defaultValue={sp.status === 'resolved' || sp.status === 'all' ? sp.status : 'open'}>
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
                <option value="all">All</option>
              </select>
            ) : (
              <select name="status" defaultValue={msgStatus ?? ''}>
                <option value="">Any</option>
                {MESSAGE_STATUSES.map(s => (
                  <option key={s} value={s}>
                    {badge(MESSAGE_STATUS, s).label}
                  </option>
                ))}
              </select>
            )}
          </label>
          {tab === 'outbox' && (
            <label>
              Template
              <select name="template" defaultValue={template ?? ''}>
                <option value="">Any</option>
                {Object.keys(TEMPLATES).map(t => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Mobile
            <input type="tel" name="mobile" inputMode="numeric" defaultValue={mobile ?? ''} placeholder="10 digits" />
          </label>
          <button className="ops-btn ops-btn-primary" type="submit">
            Filter
          </button>
        </form>
        {bad && <p className="ops-error">{bad}</p>}
      </header>
      {error ? (
        <LoadError what={tab === 'tickets' ? 'issues' : 'messages'} message={error} />
      ) : tickets ? (
        <Tickets rows={tickets} />
      ) : outbox ? (
        <Outbox
          rows={outbox.messages}
          nextHref={
            outbox.nextCursor
              ? `/admin/messages${qs({ tab, status: msgStatus, template, mobile: mobile ?? undefined, cursor: outbox.nextCursor })}`
              : null
          }
        />
      ) : (
        <LoadError what="messages" message="Unknown error." />
      )}
    </>
  );
}
