import Link from 'next/link';
import {
  canOperate,
  EXCEPTIONS_LOOKBACK_DAYS,
  listExceptions,
  loadErrorMessage,
  pageStaff,
  type ExceptionItem,
  type ExceptionsResult,
} from '@/lib/admin';
import { isYMD } from '@/lib/cutoff';
import { LoadError, pageCtx } from '@/components/admin/ops/server';
import ResolveDelivery from '@/components/admin/ops/ResolveDelivery';
import { dateTimeLabel, distance, litres, milkLabel, reasonLabel, statusLabel, ymdLabel } from '@/components/admin/ops/format';

export const dynamic = 'force-dynamic';

function ItemCard({ it, operate }: { it: ExceptionItem; operate: boolean }) {
  return (
    <li>
      <div className="ops-card-head">
        <h3>{it.name}</h3>
        <span className={`ops-badge is-${it.status}`}>{statusLabel(it.status)}</span>
      </div>
      <dl className="ops-kv" style={{ margin: '0.4rem 0' }}>
        <dt>Date</dt>
        <dd>{ymdLabel(it.date)}</dd>
        <dt>Address</dt>
        <dd>
          {it.address}
          {it.landmark ? ` (${it.landmark})` : ''}
          {it.zoneName ? ` · ${it.zoneName}` : ''}
        </dd>
        <dt>Mobile</dt>
        <dd>
          <a href={`tel:+91${it.mobile}`}>{it.mobile}</a>
        </dd>
        <dt>Rider</dt>
        <dd>{it.riderName}</dd>
        <dt>Items</dt>
        <dd>
          {milkLabel(it.milk)} {litres(it.litres)}
          {it.source !== 'plan' ? ` (${it.source === 'makeup' ? 'make-up' : 'extra'})` : ''}
        </dd>
        {it.reason && (
          <>
            <dt>Reason</dt>
            <dd>
              {reasonLabel(it.reason)}
              {it.reasonNote ? ` — “${it.reasonNote}”` : ''}
            </dd>
          </>
        )}
        {it.note && (
          <>
            <dt>Note</dt>
            <dd>{it.note}</dd>
          </>
        )}
      </dl>
      {it.kind === 'flagged_proof' && (
        <div style={{ margin: '0.4rem 0' }}>
          <p style={{ margin: '0 0 0.3rem' }}>
            <strong>Why flagged: </strong>
            {!it.proof?.photoUrl ? 'no photo (the rider typed a note instead)' : null}
            {it.proof?.photoUrl && it.proof.distanceFromPinM !== undefined
              ? `tapped ${distance(it.proof.distanceFromPinM)} from the pin`
              : null}
            {it.proof?.photoUrl && it.proof.distanceFromPinM === undefined
              ? it.proof.hasGps
                ? 'distance could not be measured (no pin on record)'
                : 'no GPS from the phone'
              : null}
            {it.proof?.capturedAt ? ` · ${dateTimeLabel(it.proof.capturedAt)}` : ''}
          </p>
          {it.proof?.photoUrl && (
            <a href={it.proof.photoUrl} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element -- private, access-checked photo route */}
              <img className="ops-photo" src={it.proof.photoUrl} alt={`Doorstep photo for ${it.name}`} loading="lazy" />
            </a>
          )}
        </div>
      )}
      {operate ? (
        <ResolveDelivery deliveryId={it.deliveryId} mode={it.kind} />
      ) : (
        <p className="ops-muted">Read-only: an owner or ops lead resolves this.</p>
      )}
    </li>
  );
}

function Group({ title, hint, items, operate, empty }: { title: string; hint: string; items: ExceptionItem[]; operate: boolean; empty: string }) {
  return (
    <section className="ops-card" aria-label={title}>
      <div className="ops-card-head">
        <h2>{title}</h2>
        <span className={`ops-badge ${items.length ? 'is-warn' : 'is-ok'}`}>{items.length}</span>
      </div>
      <p className="ops-muted">{hint}</p>
      {items.length === 0 ? <p className="ops-empty">{empty}</p> : <ul className="ops-list">{items.map(it => <ItemCard key={it.deliveryId} it={it} operate={operate} />)}</ul>}
    </section>
  );
}

export default async function AdminExceptionsPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const p = await pageStaff();
  if (!p) return null;
  const ctx = await pageCtx(p);
  const sp = await searchParams;
  const date = sp.date && isYMD(sp.date) ? sp.date : undefined;
  const operate = canOperate(p.staffRole);

  let res: ExceptionsResult | null = null;
  let error: string | null = null;
  try {
    res = await listExceptions(date, ctx);
  } catch (err) {
    error = loadErrorMessage(err);
  }

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Exceptions</p>
        <h1>{date ? ymdLabel(date) : `Last ${EXCEPTIONS_LOOKBACK_DAYS} days`}</h1>
        <form className="ops-datebar" method="get">
          <label>
            Date
            <input type="date" name="date" defaultValue={date ?? ''} />
          </label>
          <button className="ops-btn" type="submit">
            Show
          </button>
          {date && (
            <Link className="ops-btn" href="/admin/exceptions">
              All recent
            </Link>
          )}
        </form>
        {sp.date && !date && <p className="ops-error">That date was not valid, so the last {EXCEPTIONS_LOOKBACK_DAYS} days are shown.</p>}
      </header>

      {error || !res ? (
        <LoadError what="the exceptions queue" message={error ?? 'Unknown error.'} />
      ) : (
        <>
          <Group
            title="Unconfirmed"
            hint="The day closed with no tap from the rider. Unresolved after 24 hours they count as our miss and are compensated automatically."
            items={res.unconfirmed}
            operate={operate}
            empty="Nothing unconfirmed."
          />
          <Group
            title="Fault unknown"
            hint="Not delivered, and the reason does not say whose fault it was. Our fault compensates the customer; customer side does not."
            items={res.unknownFault}
            operate={operate}
            empty="No misses waiting for a fault decision."
          />
          <Group
            title="Flagged proof"
            hint="Marked delivered, but with no photo or far from the customer's pin. Check the photo; if the milk did not reach the door, mark it not delivered."
            items={res.flaggedProofs}
            operate={operate}
            empty="No flagged proofs."
          />
        </>
      )}
    </>
  );
}
