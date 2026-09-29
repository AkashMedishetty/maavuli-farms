/**
 * The customer dashboard: read model + the customer's own profile writes.
 * OWNER: B9.
 *
 * READ: `getAccountView(mobile, ctx)` assembles everything /account shows. Each
 * section is loaded independently and reported as `{ok:true,data}` or
 * `{ok:false,error}`, so one failed read (say, the credit ledger) renders as
 * "could not load" for that section instead of the whole page — and never as an
 * empty "no plans" state. All values are plain JSON (strings, numbers, booleans),
 * safe to pass straight to client components.
 *
 * WRITE: `changeAddress`, `updatePreferences`, `reportDeliveryProblem`. Identity is
 * always the session mobile passed in by the route; nothing here trusts a body.
 */

import { ObjectId, type Db } from 'mongodb';
import { getDb } from './db';
import {
  col,
  stopKeyOf,
  type AddressParts,
  type CreditEntry,
  type Delivery,
  type DomainEvent,
  type Lang,
  type NotDeliveredReason,
  type Refund,
  type Subscription,
  type Ticket,
  type TicketKind,
  type User,
} from './models';
import { addDaysYMD, isYMD, istYMD } from './cutoff';
import { firstOpenDateNow, isDateLocked } from './daylock';
import { getOpsSettings } from './settings';
import { recordEvent, customerTimeline } from './events';
import { creditBalance, creditHistory } from './credits';
import { listTickets, createTicket } from './tickets';
import { setWhatsappOptIn } from './notify/optin';
import { zoneForPoint } from './serviceability';
import { markRouteDirty } from './route-plan';
import { ensureLocked } from './manifest';
import { normalizePoint } from './geo';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import type { OpCtx } from './clock';

/* ================================================================ types == */

export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

export type DayState =
  | 'planned'
  | 'locked'
  | 'out_for_delivery'
  | 'delivered'
  | 'not_delivered'
  | 'unconfirmed'
  | 'cancelled'
  | 'paused'
  | 'none';

export interface DeliveryView {
  id: string;
  subscriptionId: string;
  date: string;
  source: 'plan' | 'makeup' | 'extra';
  kind: 'cow' | 'buffalo';
  litres: number;
  state: DayState;
  /** one human line, e.g. "Delivered at 6:42 am" */
  label: string;
  /** ISO, when delivered */
  deliveredAt: string | null;
  reason: NotDeliveredReason | null;
  reasonLabel: string | null;
  /** how a miss was (or will be) made good — null when not a miss */
  resolutionLabel: string | null;
  /** same-origin URL of the doorstep photo, when there is one */
  photoUrl: string | null;
  /** true when the customer may report a problem on it (it happened, or should have) */
  reportable: boolean;
}

export interface DayView {
  date: string;
  /** every row that day for this plan (plan/makeup + any extra) */
  rows: DeliveryView[];
  /** true when the plan has this date paused */
  paused: boolean;
  /** true when changes for this date are closed */
  closed: boolean;
}

export interface PlanView {
  id: string;
  kind: 'cow' | 'buffalo';
  litresPerDay: number;
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
  startDate: string;
  endDate: string;
  daysTotal: number;
  daysDelivered: number;
  /** plan/makeup deliveries still to come (today onward, not yet delivered/missed) */
  daysLeft: number;
  pauseAllowanceDays: number;
  pauseUsedDays: number;
  pauseRemainingDays: number;
  address: string | null;
  landmark: string | null;
  instructions: string | null;
  cancelEffectiveDate: string | null;
  /** the queued renewal that starts after this plan, if any */
  renewal: { id: string; startDate: string; endDate: string; status: string } | null;
  /** this plan continues an earlier one */
  renewalOfId: string | null;
  /** renew button: live plan, <= 10 days left, no renewal queued */
  canRenew: boolean;
  /** pause / extra / cancel are possible */
  live: boolean;
  today: DayView;
  tomorrow: DayView;
}

export interface CreditEntryView {
  id: string;
  amountPaise: number;
  kind: CreditEntry['kind'];
  label: string;
  refundable: boolean;
  note: string | null;
  at: string;
}

export interface CreditsView {
  balancePaise: number;
  refundablePaise: number;
  entries: CreditEntryView[];
}

export interface RefundView {
  id: string;
  subscriptionId: string;
  status: Refund['status'];
  statusLabel: string;
  amountPaise: number;
  method: Refund['method'];
  upiId: string | null;
  /** awaiting_upi and no UPI id given yet */
  needsUpi: boolean;
  createdAt: string;
  breakdown: Refund['breakdown'];
}

export interface TicketView {
  id: string;
  kind: TicketKind;
  kindLabel: string;
  status: Ticket['status'];
  note: string | null;
  resolution: string | null;
  deliveryId: string | null;
  deliveryDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineItem {
  id: string;
  at: string;
  label: string;
}

export interface ProfileView {
  mobile: string;
  name: string | null;
  address: string | null;
  addressParts: AddressParts | null;
  landmark: string | null;
  instructions: string | null;
  location: { lat: number; lng: number } | null;
  lang: Lang;
  whatsappOptIn: boolean;
  missedDeliveryPreference: 'makeup_day' | 'credit';
  notifyDailyDelivered: boolean;
}

export interface AccountView {
  today: string;
  tomorrow: string;
  firstOpenDate: string;
  cutoffTime: string;
  windowStart: string;
  windowEnd: string;
  profile: Section<ProfileView>;
  plans: Section<PlanView[]>;
  history: Section<DeliveryView[]>;
  credits: Section<CreditsView>;
  refunds: Section<RefundView[]>;
  tickets: Section<TicketView[]>;
  timeline: Section<TimelineItem[]>;
}

/* =============================================================== labels == */

const REASON_LABEL: Record<NotDeliveredReason, string> = {
  out_of_stock: 'we ran out of milk',
  vehicle_issue: 'a vehicle problem on our side',
  rider_absent: 'our delivery partner was unavailable',
  disruption: 'a disruption in your area',
  spoiled: 'the milk was not fit to deliver',
  no_access: 'we could not reach your door',
  refused: 'the delivery was refused',
  customer_asked_skip: 'you asked us to skip it',
  could_not_find: 'we could not find the address',
  other: 'another reason',
};

const CREDIT_LABEL: Record<CreditEntry['kind'], string> = {
  missed_delivery: 'Missed delivery — value returned',
  goodwill: 'Goodwill credit',
  makeup_spend: 'Used for a make-up day',
  extra_spend: 'Used for extra milk',
  order_spend: 'Used for a plan',
  order_spend_reversal: 'Returned — order not completed',
  refund_payout: 'Paid out in a refund',
  cancellation_balance: 'Cancellation balance',
  adjustment: 'Adjustment',
};

const REFUND_LABEL: Record<Refund['status'], string> = {
  pending: 'Being prepared',
  processing: 'On its way to your original payment method',
  processed: 'Refunded',
  failed: 'Refund did not go through — our team is on it',
  awaiting_upi: 'Needs your UPI id',
  paid_manually: 'Paid to your UPI id',
};

export const TICKET_KIND_LABEL: Record<TicketKind, string> = {
  not_received: 'Milk not received',
  spoiled: 'Milk spoiled',
  quantity: 'Wrong quantity',
  other: 'Something else',
};

const EVENT_LABEL: Record<string, string> = {
  'order.created': 'Order started',
  'order.paid': 'Payment received',
  'order.failed': 'Payment did not go through',
  'order.expired': 'Unpaid order expired',
  'order.refunded': 'Order refunded',
  'order.partially_refunded': 'Order partly refunded',
  'order.extra_credited': 'Extra milk paid from credit',
  'order.credit_shortfall': 'Credit was not enough for this order',
  'subscription.created': 'Plan created',
  'subscription.activated': 'Plan started',
  'subscription.completed': 'Plan finished',
  'subscription.cancelled': 'Plan cancelled',
  'subscription.extended': 'Plan extended',
  'subscription.shortened': 'Plan end date moved earlier',
  'subscription.paused_dates': 'Deliveries paused',
  'subscription.unpaused_dates': 'Paused deliveries restored',
  'subscription.renewal_shifted': 'Renewal start moved',
  'subscription.makeup_removed': 'Make-up day removed',
  'delivery.planned': 'Delivery added',
  'delivery.delivered': 'Milk delivered',
  'delivery.not_delivered': 'Delivery missed',
  'delivery.compensated': 'Missed delivery made good',
  'delivery.fault_set': 'Missed delivery reviewed',
  'refund.created': 'Refund created',
  'refund.processing': 'Refund sent to your payment method',
  'refund.processed': 'Refund completed',
  'refund.failed': 'Refund did not go through',
  'refund.awaiting_upi': 'Refund needs your UPI id',
  'refund.paid_manually': 'Refund paid to your UPI id',
  'refund.upi_set': 'UPI id received for refund',
  'ticket.created': 'Problem reported',
  'ticket.resolved': 'Reported problem resolved',
  'customer.whatsapp_opt_in': 'WhatsApp updates turned on',
  'customer.whatsapp_opt_out': 'WhatsApp updates turned off',
  'customer.address_changed': 'Delivery address changed',
  'customer.preference_changed': 'Preferences updated',
};

function eventLabel(ev: DomainEvent): string {
  const known = EVENT_LABEL[ev.type];
  if (known) return known;
  if (ev.type.startsWith('credit.')) {
    const k = ev.type.slice(7) as CreditEntry['kind'];
    return CREDIT_LABEL[k] ?? 'Credit updated';
  }
  // unknown future type: a readable fallback, never the raw code
  const verb = ev.type.split('.').pop() ?? ev.type;
  return `${ev.entity.replace(/_/g, ' ')} ${verb.replace(/_/g, ' ')}`.replace(/^\w/, c => c.toUpperCase());
}

/** Events that are internal plumbing and mean nothing to a customer. */
const HIDDEN_EVENTS = new Set(['delivery.planned', 'rider_run.started', 'rider_run.closed', 'rider_run.reassigned']);

const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });

function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotConfiguredError') return 'The account service is not reachable right now.';
  // eslint-disable-next-line no-console
  console.error('[account] section failed', err instanceof Error ? err.message : err);
  return 'This could not be loaded just now. Please refresh in a moment.';
}

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

function photoUrlOf(key: string | undefined): string | null {
  if (!key || !key.startsWith('photos/')) return null;
  return `/api/photos/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/* ======================================================== delivery view == */

function stateOf(status: Delivery['status']): DayState {
  switch (status) {
    case 'planned':
    case 'scheduled':
      return 'planned';
    case 'skipped':
    case 'failed':
      return 'not_delivered';
    default:
      return status;
  }
}

function resolutionLabelOf(d: Delivery): string | null {
  const state = stateOf(d.status);
  if (state !== 'not_delivered') return null;
  if (d.resolution === 'makeup_day') return 'A make-up day was added to the end of your plan.';
  if (d.resolution === 'credit') return 'The value of this delivery was added to your credit.';
  if (d.resolution === 'none' || d.fault === 'customer') return 'No make-up for this one (customer-side reason).';
  if (d.fault === 'ours') return 'Our fault — a make-up day or credit is being added.';
  return 'Our team is reviewing this.';
}

export function deliveryView(d: Delivery, closedByTime = false): DeliveryView {
  const state = stateOf(d.status);
  const source = d.source ?? 'plan';
  const extra = source === 'extra' ? 'Extra milk: ' : source === 'makeup' ? 'Make-up day: ' : '';
  const reasonLabel = d.reason ? REASON_LABEL[d.reason] : null;
  let label: string;
  switch (state) {
    case 'planned':
      label = closedByTime ? 'Confirmed — changes for this day have closed' : 'Planned';
      break;
    case 'locked':
      label = 'Confirmed — on the delivery round';
      break;
    case 'out_for_delivery':
      label = 'Out for delivery';
      break;
    case 'delivered':
      label = d.deliveredAt ? `Delivered at ${timeFmt.format(d.deliveredAt)}` : 'Delivered';
      break;
    case 'not_delivered':
      label = reasonLabel ? `Not delivered — ${reasonLabel}` : 'Not delivered';
      break;
    case 'unconfirmed':
      label = 'Awaiting confirmation from our delivery partner';
      break;
    case 'cancelled':
      label = 'Cancelled';
      break;
    default:
      label = 'Planned';
  }
  return {
    id: d._id ? d._id.toHexString() : '',
    subscriptionId: d.subscriptionId.toHexString(),
    date: d.date,
    source,
    kind: d.kind,
    litres: d.litres,
    state,
    label: extra + label,
    deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : null,
    reason: d.reason ?? null,
    reasonLabel,
    resolutionLabel: resolutionLabelOf(d),
    photoUrl: photoUrlOf(d.proof?.photoKey),
    reportable: ['delivered', 'not_delivered', 'unconfirmed', 'out_for_delivery'].includes(state),
  };
}

/* ============================================================ read model == */

const LIVE: readonly Subscription['status'][] = ['scheduled', 'active', 'paused'];
const LEFT_STATES: readonly Delivery['status'][] = ['planned', 'locked', 'out_for_delivery', 'scheduled'];

function planStatus(s: Subscription['status']): PlanView['status'] {
  return s === 'paused' ? 'active' : s;
}

async function loadPlans(db: Db, mobile: string, today: string, tomorrow: string, ctx: OpCtx): Promise<PlanView[]> {
  const subs = await col.subscriptions(db).find({ mobile }).sort({ startDate: -1, createdAt: -1 }).limit(50).toArray();
  if (subs.length === 0) return [];
  const ids = subs.map(s => s._id).filter((x): x is ObjectId => !!x);

  const [dayRows, leftCounts, pausedNear, todayClosed, tomorrowClosed] = await Promise.all([
    col.deliveries(db).find({ subscriptionId: { $in: ids }, date: { $in: [today, tomorrow] } }).toArray(),
    col
      .deliveries(db)
      .aggregate<{ _id: ObjectId; n: number }>([
        {
          $match: {
            subscriptionId: { $in: ids },
            date: { $gte: today },
            status: { $in: [...LEFT_STATES] },
            source: { $ne: 'extra' },
          },
        },
        { $group: { _id: '$subscriptionId', n: { $sum: 1 } } },
      ])
      .toArray(),
    col.pausedDates(db).find({ subscriptionId: { $in: ids }, date: { $in: [today, tomorrow] } }).toArray(),
    isDateLocked(today, ctx, db),
    isDateLocked(tomorrow, ctx, db),
  ]);

  const renewalIds = subs.map(s => s.renewedBy).filter((x): x is ObjectId => !!x);
  const renewals = renewalIds.length
    ? await col.subscriptions(db).find({ _id: { $in: renewalIds }, mobile }).toArray()
    : [];
  const renewalById = new Map(renewals.map(r => [String(r._id), r]));
  const leftBy = new Map(leftCounts.map(c => [String(c._id), c.n]));

  const dayOf = (subId: string, date: string, closed: boolean): DayView => ({
    date,
    rows: dayRows
      .filter(r => String(r.subscriptionId) === subId && r.date === date)
      .sort((a, b) => (a.source === 'extra' ? 1 : 0) - (b.source === 'extra' ? 1 : 0))
      .map(r => deliveryView(r, closed)),
    paused: pausedNear.some(p => String(p.subscriptionId) === subId && p.date === date),
    closed,
  });

  return subs
    .filter((s): s is Subscription & { _id: ObjectId } => !!s._id)
    .map(s => {
      const id = s._id.toHexString();
      const live = LIVE.includes(s.status);
      const daysLeft = live ? (leftBy.get(id) ?? 0) : 0;
      const r = s.renewedBy ? renewalById.get(String(s.renewedBy)) : undefined;
      return {
        id,
        kind: s.kind,
        litresPerDay: s.qtyNum / s.qtyDen,
        status: planStatus(s.status),
        startDate: s.startDate,
        endDate: s.endDate,
        daysTotal: s.daysTotal,
        daysDelivered: s.daysDelivered,
        daysLeft,
        pauseAllowanceDays: s.pauseAllowanceDays ?? 0,
        pauseUsedDays: s.pauseUsedDays ?? 0,
        pauseRemainingDays: Math.max(0, (s.pauseAllowanceDays ?? 0) - (s.pauseUsedDays ?? 0)),
        address: s.address ?? null,
        landmark: s.landmark ?? null,
        instructions: s.instructions ?? null,
        cancelEffectiveDate: s.cancelEffectiveDate ?? null,
        renewal: r?._id
          ? { id: r._id.toHexString(), startDate: r.startDate, endDate: r.endDate, status: planStatus(r.status) }
          : s.renewedBy
            ? { id: s.renewedBy.toHexString(), startDate: '', endDate: '', status: 'unknown' }
            : null,
        renewalOfId: s.renewalOf ? s.renewalOf.toHexString() : null,
        canRenew: live && !s.renewedBy && daysLeft <= 10,
        live,
        today: dayOf(id, today, todayClosed),
        tomorrow: dayOf(id, tomorrow, tomorrowClosed),
      };
    });
}

async function loadHistory(db: Db, mobile: string, today: string): Promise<DeliveryView[]> {
  const rows = await col
    .deliveries(db)
    .find({ mobile, date: { $lte: today }, status: { $nin: ['planned', 'scheduled'] } })
    .sort({ date: -1 })
    .limit(30)
    .toArray();
  return rows.map(r => deliveryView(r));
}

async function loadCredits(mobile: string): Promise<CreditsView> {
  const [bal, rows] = await Promise.all([creditBalance(mobile), creditHistory(mobile, 50)]);
  return {
    balancePaise: bal.balancePaise,
    refundablePaise: bal.refundablePaise,
    entries: rows.map(e => ({
      id: e._id ? e._id.toHexString() : '',
      amountPaise: e.amountPaise,
      kind: e.kind,
      label: CREDIT_LABEL[e.kind] ?? 'Credit',
      refundable: e.refundable,
      note: e.note ?? null,
      at: e.at.toISOString(),
    })),
  };
}

async function loadRefunds(db: Db, mobile: string): Promise<RefundView[]> {
  const rows = await col.refunds(db).find({ mobile }).sort({ createdAt: -1 }).limit(20).toArray();
  return rows
    .filter((r): r is Refund & { _id: ObjectId } => !!r._id)
    .map(r => ({
      id: r._id.toHexString(),
      subscriptionId: r.subscriptionId.toHexString(),
      status: r.status,
      statusLabel:
        r.status === 'awaiting_upi' && r.upiId ? 'UPI id received — our team will pay it shortly' : REFUND_LABEL[r.status],
      amountPaise: r.amountPaise,
      method: r.method,
      upiId: r.upiId ?? null,
      needsUpi: r.status === 'awaiting_upi' && !r.upiId,
      createdAt: r.createdAt.toISOString(),
      breakdown: r.breakdown,
    }));
}

async function loadTickets(db: Db, mobile: string): Promise<TicketView[]> {
  const rows = await listTickets({ mobile }, 30);
  const dIds = rows.map(t => t.deliveryId).filter((x): x is ObjectId => !!x);
  const dates = dIds.length
    ? await col.deliveries(db).find({ _id: { $in: dIds }, mobile }, { projection: { date: 1 } }).toArray()
    : [];
  const dateOf = new Map(dates.map(d => [String(d._id), d.date]));
  return rows
    .filter((t): t is Ticket & { _id: ObjectId } => !!t._id)
    .map(t => ({
      id: t._id.toHexString(),
      kind: t.kind,
      kindLabel: TICKET_KIND_LABEL[t.kind] ?? 'Problem',
      status: t.status,
      note: t.note ?? null,
      resolution: t.status === 'resolved' ? (t.resolution ?? null) : null,
      deliveryId: t.deliveryId ? t.deliveryId.toHexString() : null,
      deliveryDate: t.deliveryId ? (dateOf.get(String(t.deliveryId)) ?? null) : null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));
}

async function loadTimeline(mobile: string): Promise<TimelineItem[]> {
  const evs = await customerTimeline(mobile, 80);
  return evs
    .filter(e => !HIDDEN_EVENTS.has(e.type) && !e.type.startsWith('rider_run.') && !e.type.startsWith('day.'))
    .slice(0, 50)
    .map((e, i) => ({ id: e._id ? e._id.toHexString() : `ev${i}`, at: e.at.toISOString(), label: eventLabel(e) }));
}

function profileOf(mobile: string, u: User | null): ProfileView {
  return {
    mobile,
    name: u?.name ?? null,
    address: u?.address ?? null,
    addressParts: u?.addressParts ?? null,
    landmark: u?.landmark ?? null,
    instructions: u?.instructions ?? null,
    location: u?.location ? { lat: u.location.lat, lng: u.location.lng } : null,
    lang: u?.lang === 'te' ? 'te' : 'en',
    whatsappOptIn: u?.whatsappOptIn === true,
    missedDeliveryPreference: u?.missedDeliveryPreference === 'credit' ? 'credit' : 'makeup_day',
    notifyDailyDelivered: u?.notifyDailyDelivered === true,
  };
}

/**
 * Everything /account shows. Throws only when the database itself is unreachable
 * (the page shows a full-page "temporarily unavailable"); any narrower failure is
 * confined to its section.
 */
export async function getAccountView(mobile: string, ctx: OpCtx): Promise<AccountView> {
  const db = await getDb();
  const today = istYMD(ctx.now);
  const tomorrow = addDaysYMD(today, 1);
  const [settings, firstOpenDate] = await Promise.all([getOpsSettings(db), firstOpenDateNow(ctx, db)]);

  const [profile, plans, history, credits, refunds, tickets, timeline] = await Promise.all([
    section(async () => profileOf(mobile, await col.users(db).findOne({ mobile }))),
    section(() => loadPlans(db, mobile, today, tomorrow, ctx)),
    section(() => loadHistory(db, mobile, today)),
    section(() => loadCredits(mobile)),
    section(() => loadRefunds(db, mobile)),
    section(() => loadTickets(db, mobile)),
    section(() => loadTimeline(mobile)),
  ]);

  return {
    today,
    tomorrow,
    firstOpenDate,
    cutoffTime: settings.cutoffTime,
    windowStart: settings.windowStart,
    windowEnd: settings.windowEnd,
    profile,
    plans,
    history,
    credits,
    refunds,
    tickets,
    timeline,
  };
}

/* ======================================================== address change == */

export interface AddressInput {
  location: { lat: number; lng: number };
  addressParts: AddressParts;
  landmark?: string;
  instructions?: string;
}

export interface AddressChangeResult {
  effectiveFrom: string;
  zoneName: string;
  plansUpdated: number;
  deliveriesUpdated: number;
  address: string;
}

function optText(v: unknown, field: string, max: number, issues: string[]): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    issues.push(`${field} must be text`);
    return undefined;
  }
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length > max) issues.push(`${field} must be at most ${max} characters`);
  return t || undefined;
}

/** Validate a raw POST /api/account/address body. */
export function parseAddressInput(body: Record<string, unknown>): AddressInput {
  const issues: string[] = [];
  const loc = body.location as { lat?: unknown; lng?: unknown } | undefined;
  const point = loc && typeof loc === 'object' ? normalizePoint(loc.lat, loc.lng) : null;
  if (!point) issues.push('location must be {lat, lng} — drop the pin on your door');

  const raw = (body.addressParts && typeof body.addressParts === 'object' ? body.addressParts : {}) as Record<string, unknown>;
  const house = optText(raw.house, 'house / flat', 100, issues);
  if (!house) issues.push('house / flat number is required');
  const parts: AddressParts = { house: house ?? '' };
  const floor = optText(raw.floor, 'floor', 40, issues);
  const building = optText(raw.building, 'building', 100, issues);
  const society = optText(raw.society, 'society / street', 150, issues);
  const area = optText(raw.area, 'area', 150, issues);
  const pincodeRaw = optText(raw.pincode, 'pincode', 6, issues);
  if (pincodeRaw && !/^\d{6}$/.test(pincodeRaw)) issues.push('pincode must be 6 digits');
  if (floor) parts.floor = floor;
  if (building) parts.building = building;
  if (society) parts.society = society;
  if (area) parts.area = area;
  if (pincodeRaw) parts.pincode = pincodeRaw;

  const landmark = optText(body.landmark, 'landmark', 200, issues);
  const instructions = optText(body.instructions, 'instructions', 300, issues);
  if (issues.length || !point) throw new ValidationError('Please check the address', issues);
  return {
    location: { lat: point.lat, lng: point.lng },
    addressParts: parts,
    ...(landmark ? { landmark } : {}),
    ...(instructions ? { instructions } : {}),
  };
}

/** The one-line address a rider reads out loud, built from the parts. */
export function addressLine(p: AddressParts): string {
  const flat = p.floor ? `${p.house}, floor ${p.floor}` : p.house;
  return [flat, p.building, p.society, p.area, p.pincode].filter(Boolean).join(', ');
}

/**
 * Move the customer's doorstep. Applies from the first open date:
 *  · days that are already closed are frozen first (ensureLocked), so their stop
 *    snapshot keeps the OLD address;
 *  · the profile and every scheduled/active plan take the new address, pin,
 *    stopKey and zone;
 *  · PLANNED deliveries (only) get the new stopKey; locked ones keep their snapshot;
 *  · the old and new zone riders' standing routes are marked dirty.
 */
export async function changeAddress(mobile: string, input: AddressInput, ctx: OpCtx): Promise<AddressChangeResult> {
  const zone = await zoneForPoint(input.location);
  if (!zone?._id) {
    throw new ValidationError('That pin is outside our delivery area', [
      'Move the pin onto your door. If it is already there, we do not deliver to that spot yet.',
    ]);
  }
  const db = await getDb();

  // Freeze any day already past its cutoff with the address it was promised to.
  const today = istYMD(ctx.now);
  let firstOpen = await firstOpenDateNow(ctx, db);
  for (let d = today; d < firstOpen; d = addDaysYMD(d, 1)) await ensureLocked(d, ctx);
  firstOpen = await firstOpenDateNow(ctx, db);

  const address = addressLine(input.addressParts);
  const stopKey = stopKeyOf(mobile, input.location);
  const pincode = input.addressParts.pincode;

  const subs = await col
    .subscriptions(db)
    .find({ mobile, status: { $in: ['scheduled', 'active', 'paused'] } })
    .toArray();

  const oldZoneIds = subs.map(s => s.zoneId).filter((x): x is ObjectId => !!x);
  const oldZones = oldZoneIds.length ? await col.zones(db).find({ _id: { $in: oldZoneIds } }).toArray() : [];

  const unsetFields: Record<string, ''> = {};
  if (!input.landmark) unsetFields.landmark = '';
  if (!input.instructions) unsetFields.instructions = '';

  const common = {
    address,
    addressParts: input.addressParts,
    location: input.location,
    ...(input.landmark ? { landmark: input.landmark } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(pincode ? { pincode } : {}),
  };

  await col.users(db).updateOne(
    { mobile },
    { $set: common, ...(Object.keys(unsetFields).length ? { $unset: unsetFields } : {}) },
  );

  let plansUpdated = 0;
  let deliveriesUpdated = 0;
  const subIds = subs.map(s => s._id).filter((x): x is ObjectId => !!x);
  if (subIds.length) {
    const r = await col.subscriptions(db).updateMany(
      { _id: { $in: subIds }, mobile, status: { $in: ['scheduled', 'active', 'paused'] } },
      {
        $set: { ...common, stopKey, zoneId: zone._id },
        ...(Object.keys(unsetFields).length ? { $unset: unsetFields } : {}),
      },
    );
    plansUpdated = r.modifiedCount;
    const d = await col.deliveries(db).updateMany(
      { subscriptionId: { $in: subIds }, status: 'planned', date: { $gte: firstOpen } },
      { $set: { stopKey, ...(pincode ? { pincode } : {}), updatedAt: ctx.now } },
    );
    deliveriesUpdated = d.modifiedCount;
  }

  const riders = new Map<string, ObjectId>();
  for (const z of oldZones) if (z.riderId) riders.set(String(z.riderId), z.riderId);
  if (zone.riderId) riders.set(String(zone.riderId), zone.riderId);
  for (const rid of riders.values()) await markRouteDirty(rid, `customer address change (${mobile.slice(-4)})`, ctx);

  await recordEvent(
    ctx,
    {
      entity: 'customer',
      entityId: mobile,
      type: 'customer.address_changed',
      mobile,
      data: {
        effectiveFrom: firstOpen,
        zoneId: zone._id.toHexString(),
        plans: subIds.map(i => i.toHexString()),
        deliveriesUpdated,
      },
    },
    db,
  );

  return { effectiveFrom: firstOpen, zoneName: zone.name, plansUpdated, deliveriesUpdated, address };
}

/* =========================================================== preferences == */

export interface PreferencesInput {
  whatsappOptIn?: boolean;
  missedDeliveryPreference?: 'makeup_day' | 'credit';
  notifyDailyDelivered?: boolean;
  lang?: Lang;
}

export function parsePreferencesInput(body: Record<string, unknown>): PreferencesInput {
  const issues: string[] = [];
  const out: PreferencesInput = {};
  const allowed = ['whatsappOptIn', 'missedDeliveryPreference', 'notifyDailyDelivered', 'lang'];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) issues.push(`unknown field "${k}"`);
  if (body.whatsappOptIn !== undefined) {
    if (typeof body.whatsappOptIn !== 'boolean') issues.push('whatsappOptIn must be true or false');
    else out.whatsappOptIn = body.whatsappOptIn;
  }
  if (body.notifyDailyDelivered !== undefined) {
    if (typeof body.notifyDailyDelivered !== 'boolean') issues.push('notifyDailyDelivered must be true or false');
    else out.notifyDailyDelivered = body.notifyDailyDelivered;
  }
  if (body.missedDeliveryPreference !== undefined) {
    if (body.missedDeliveryPreference !== 'makeup_day' && body.missedDeliveryPreference !== 'credit') {
      issues.push('missedDeliveryPreference must be makeup_day or credit');
    } else out.missedDeliveryPreference = body.missedDeliveryPreference;
  }
  if (body.lang !== undefined) {
    if (body.lang !== 'en' && body.lang !== 'te') issues.push('lang must be en or te');
    else out.lang = body.lang;
  }
  if (!issues.length && Object.keys(out).length === 0) issues.push('nothing to change');
  if (issues.length) throw new ValidationError('Please check your preferences', issues);
  return out;
}

/** Apply preference changes; one event per field that actually changed. */
export async function updatePreferences(mobile: string, input: PreferencesInput, ctx: OpCtx): Promise<ProfileView> {
  const db = await getDb();
  const user = await col.users(db).findOne({ mobile });
  if (!user) throw new NotFoundError('Account not found');
  const before = profileOf(mobile, user);

  if (input.whatsappOptIn !== undefined && input.whatsappOptIn !== before.whatsappOptIn) {
    // the one place the opt-in flag is flipped; it records its own event
    await setWhatsappOptIn(mobile, input.whatsappOptIn, 'account', ctx);
  }

  const set: Partial<User> = {};
  const changes: { field: string; from: string; to: string }[] = [];
  if (input.missedDeliveryPreference && input.missedDeliveryPreference !== before.missedDeliveryPreference) {
    set.missedDeliveryPreference = input.missedDeliveryPreference;
    changes.push({ field: 'missedDeliveryPreference', from: before.missedDeliveryPreference, to: input.missedDeliveryPreference });
  }
  if (input.notifyDailyDelivered !== undefined && input.notifyDailyDelivered !== before.notifyDailyDelivered) {
    set.notifyDailyDelivered = input.notifyDailyDelivered;
    changes.push({ field: 'notifyDailyDelivered', from: String(before.notifyDailyDelivered), to: String(input.notifyDailyDelivered) });
  }
  if (input.lang && input.lang !== before.lang) {
    set.lang = input.lang;
    changes.push({ field: 'lang', from: before.lang, to: input.lang });
  }
  if (changes.length) {
    await col.users(db).updateOne({ mobile }, { $set: set });
    for (const c of changes) {
      await recordEvent(
        ctx,
        { entity: 'customer', entityId: mobile, type: 'customer.preference_changed', mobile, from: c.from, to: c.to, data: { field: c.field } },
        db,
      );
    }
  }
  return profileOf(mobile, await col.users(db).findOne({ mobile }));
}

/* =============================================================== tickets == */

export interface TicketInput {
  deliveryId: ObjectId;
  kind: TicketKind;
  note: string;
}

const TICKET_KINDS: readonly TicketKind[] = ['not_received', 'spoiled', 'quantity', 'other'];

export function parseTicketInput(body: Record<string, unknown>): TicketInput {
  const issues: string[] = [];
  const { deliveryId, kind, note } = body;
  if (typeof deliveryId !== 'string' || !/^[a-f0-9]{24}$/i.test(deliveryId)) issues.push('deliveryId must be an id');
  if (typeof kind !== 'string' || !TICKET_KINDS.includes(kind as TicketKind)) {
    issues.push('kind must be not_received, spoiled, quantity or other');
  }
  const text = typeof note === 'string' ? note.trim() : '';
  if (typeof note !== 'string') issues.push('note is required');
  else if (text.length < 3) issues.push('Tell us a little more (at least 3 characters)');
  else if (text.length > 500) issues.push('note must be at most 500 characters');
  if (issues.length) throw new ValidationError('Please check the report', issues);
  return { deliveryId: new ObjectId(deliveryId as string), kind: kind as TicketKind, note: text };
}

/** Report a problem on one of the customer's own deliveries (404 for anyone else's). */
export async function reportDeliveryProblem(mobile: string, input: TicketInput, ctx: OpCtx): Promise<TicketView> {
  const db = await getDb();
  const d = await col.deliveries(db).findOne({ _id: input.deliveryId });
  if (!d?._id || d.mobile !== mobile) throw new NotFoundError('Delivery not found');
  const today = istYMD(ctx.now);
  if (!isYMD(d.date) || d.date > today) throw new ConflictError('You can report a problem once the delivery day has come.');
  const openAlready = await col.tickets(db).findOne({ mobile, deliveryId: d._id, status: 'open' });
  if (openAlready) throw new ConflictError('You have already reported this delivery — our team is looking at it.');

  const t = await createTicket(
    { mobile, kind: input.kind, channel: 'web', deliveryId: d._id, subscriptionId: d.subscriptionId, note: input.note },
    ctx,
  );
  return {
    id: t._id ? t._id.toHexString() : '',
    kind: t.kind,
    kindLabel: TICKET_KIND_LABEL[t.kind],
    status: t.status,
    note: t.note ?? null,
    resolution: null,
    deliveryId: d._id.toHexString(),
    deliveryDate: d.date,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
