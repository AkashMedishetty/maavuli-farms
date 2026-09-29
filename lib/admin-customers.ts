/**
 * Admin read models (and staff management) for the customers & finance screens.
 * OWNER: B7b. Server-only.
 *
 * Everything returned here is plain JSON (ids as hex strings, instants as ISO
 * strings) so a server page can hand it straight to a client component.
 *
 * Nothing here writes a subscription, delivery, refund or credit: those go through
 * their owning modules (lib/subscriptions, lib/pause, lib/refunds, lib/credits). The
 * only writes are the staff collection (owner-only staff management).
 */

import { ObjectId, type Filter } from 'mongodb';
import { getDb } from '@/lib/db';
import {
  col,
  normalizeMobile,
  type Actor,
  type CreditEntry,
  type DomainEvent,
  type MessageStatus,
  type Order,
  type OrderStatus,
  type OutboundMessage,
  type Refund,
  type RefundBreakdown,
  type RefundStatus,
  type Staff,
  type StaffRole,
  type SubStatus,
  type Subscription,
  type Ticket,
} from '@/lib/models';
import type { OpCtx } from '@/lib/clock';
import { addDaysYMD, istYMD } from '@/lib/cutoff';
import { firstOpenDateNow } from '@/lib/daylock';
import { foldBalance } from '@/lib/credits';
import { customerTimeline, recordEvent } from '@/lib/events';
import { listTickets } from '@/lib/tickets';
import { photoUrlFor } from '@/lib/admin';
import { adminMobiles } from '@/lib/env';
import { formatINR, QUANTITIES, TENURES } from '@/lib/pricing';
import { isTemplateName, render } from '@/lib/notify/templates';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';

/* ------------------------------------------------------------- helpers ---- */

const iso = (d: Date | undefined | null): string | null => (d ? d.toISOString() : null);
const hex = (id: ObjectId | undefined | null): string => (id ? id.toHexString() : '');

/** Escape a user string for a literal, case-insensitive regex match. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Per-entry goodwill caps — the one definition (lib/credits); the API enforces it. */
export { GOODWILL_CAP_PAISE } from './credits';

function milkName(kind: string): string {
  return kind === 'cow' ? 'Cow' : kind === 'buffalo' ? 'Buffalo' : kind;
}

function litresText(n: number): string {
  return `${String(Math.round(n * 100) / 100)} L`;
}

/** "Cow · 1 L/day · 3 Months" for an order, "Extra · Cow 1.5 L" for an extra. */
export function orderPlanLabel(o: Pick<Order, 'purpose' | 'kind' | 'quantityId' | 'tenureId' | 'litres' | 'days'>): string {
  if (o.purpose === 'extra') return `Extra · ${milkName(o.kind)} ${litresText(o.litres)}`;
  const q = QUANTITIES.find(x => x.id === o.quantityId);
  const t = TENURES.find(x => x.id === o.tenureId);
  const perDay = q ? `${litresText(q.num / q.den)}/day` : o.quantityId;
  return `${milkName(o.kind)} · ${perDay} · ${t ? t.label : `${o.days} days`}`;
}

function subPlanLabel(s: Pick<Subscription, 'kind' | 'qtyNum' | 'qtyDen' | 'daysTotal'>): string {
  return `${milkName(s.kind)} · ${litresText(s.qtyNum / s.qtyDen)}/day · ${s.daysTotal} days`;
}

const STATUS_RANK: Record<SubStatus, number> = { active: 5, scheduled: 4, paused: 3, completed: 2, cancelled: 1 };

/** The customer's headline plan status: the most "live" of their subscriptions. */
function headlineStatus(statuses: SubStatus[]): SubStatus | 'none' {
  let best: SubStatus | 'none' = 'none';
  for (const s of statuses) if (best === 'none' || STATUS_RANK[s] > STATUS_RANK[best]) best = s;
  return best;
}

async function balancesFor(mobiles: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!mobiles.length) return out;
  const db = await getDb();
  const rows = await col
    .credits(db)
    .find({ mobile: { $in: mobiles } }, { projection: { mobile: 1, amountPaise: 1, kind: 1, refundable: 1, deliveryId: 1 } })
    .toArray();
  const by = new Map<string, CreditEntry[]>();
  for (const r of rows) {
    const list = by.get(r.mobile) ?? [];
    list.push(r);
    by.set(r.mobile, list);
  }
  for (const [m, list] of by) out.set(m, foldBalance(list).balancePaise);
  return out;
}

/* ------------------------------------------------------------- search ---- */

export interface CustomerRow {
  mobile: string;
  name: string | null;
  address: string | null;
  planStatus: SubStatus | 'none';
  livePlans: number;
  creditPaise: number;
  createdAt: string | null;
}

export const SEARCH_LIMIT = 50;

/**
 * Customers by mobile prefix, name or address (case-insensitive, regex-escaped).
 * Name/address also match the delivery details on a plan, since a customer's plan
 * address is the one ops actually know. Empty query = the most recent customers.
 */
export async function searchCustomers(qRaw: string): Promise<CustomerRow[]> {
  const q = qRaw.trim().slice(0, 100);
  const db = await getDb();
  const users = col.users(db);

  let mobiles: string[];
  if (!q) {
    mobiles = (await users.find({}, { projection: { mobile: 1 } }).sort({ createdAt: -1 }).limit(SEARCH_LIMIT).toArray()).map(u => u.mobile);
  } else {
    const found = new Set<string>();
    const looksNumeric = /^[\d\s+()-]+$/.test(q);
    const digits = q.replace(/\D/g, '');
    if (looksNumeric && digits.length > 0) {
      const prefix = digits.length > 10 ? digits.slice(-10) : digits;
      const re = new RegExp(`^${escapeRegex(prefix)}`);
      for (const u of await users.find({ mobile: re }, { projection: { mobile: 1 } }).limit(SEARCH_LIMIT).toArray()) found.add(u.mobile);
      for (const s of await col.subscriptions(db).find({ mobile: re }, { projection: { mobile: 1 } }).limit(SEARCH_LIMIT).toArray()) found.add(s.mobile);
    } else {
      const re = new RegExp(escapeRegex(q), 'i');
      const uq = await users
        .find({ $or: [{ name: re }, { address: re }, { landmark: re }] }, { projection: { mobile: 1 } })
        .limit(SEARCH_LIMIT)
        .toArray();
      for (const u of uq) found.add(u.mobile);
      if (found.size < SEARCH_LIMIT) {
        const sq = await col
          .subscriptions(db)
          .find({ $or: [{ name: re }, { address: re }, { landmark: re }] }, { projection: { mobile: 1 } })
          .limit(SEARCH_LIMIT)
          .toArray();
        for (const s of sq) found.add(s.mobile);
      }
    }
    mobiles = [...found].slice(0, SEARCH_LIMIT);
  }
  if (!mobiles.length) return [];

  const [userRows, subRows, balances] = await Promise.all([
    users.find({ mobile: { $in: mobiles } }, { projection: { mobile: 1, name: 1, address: 1, createdAt: 1 } }).toArray(),
    col
      .subscriptions(db)
      .find({ mobile: { $in: mobiles } }, { projection: { mobile: 1, status: 1, name: 1, address: 1, createdAt: 1 } })
      .sort({ createdAt: -1 })
      .toArray(),
    balancesFor(mobiles),
  ]);
  const userBy = new Map(userRows.map(u => [u.mobile, u]));
  const subsBy = new Map<string, typeof subRows>();
  for (const s of subRows) {
    const l = subsBy.get(s.mobile) ?? [];
    l.push(s);
    subsBy.set(s.mobile, l);
  }

  return mobiles.map(m => {
    const u = userBy.get(m);
    const subs = subsBy.get(m) ?? [];
    const latest = subs[0];
    return {
      mobile: m,
      name: u?.name ?? latest?.name ?? null,
      address: latest?.address ?? u?.address ?? null,
      planStatus: headlineStatus(subs.map(s => s.status)),
      livePlans: subs.filter(s => s.status === 'active' || s.status === 'scheduled').length,
      creditPaise: balances.get(m) ?? 0,
      createdAt: iso(u?.createdAt),
    };
  });
}

/* ------------------------------------------------------------- detail ---- */

export interface PlanView {
  id: string;
  label: string;
  status: SubStatus;
  startDate: string;
  endDate: string;
  daysTotal: number;
  daysDelivered: number;
  pauseUsedDays: number;
  pauseAllowanceDays: number;
  name: string | null;
  address: string | null;
  landmark: string | null;
  instructions: string | null;
  location: { lat: number; lng: number } | null;
  renewedBy: string | null;
  renewalOf: string | null;
  cancelledAt: string | null;
  cancelEffectiveDate: string | null;
  cancelReason: string | null;
  cancelledBy: Actor | null;
  refundId: string | null;
  /** planned plan-delivery dates from the first open date on (what can be paused) */
  pausableDates: string[];
  pausedDates: string[];
}

export interface DeliveryView {
  id: string;
  date: string;
  status: string;
  source: 'plan' | 'makeup' | 'extra';
  kind: string;
  litres: number;
  reason: string | null;
  reasonNote: string | null;
  fault: string | null;
  resolution: string | null;
  deliveredAt: string | null;
  photoUrl: string | null;
  flagged: boolean;
  note: string | null;
}

export interface OrderView {
  id: string;
  razorpayOrderId: string;
  purpose: 'new' | 'renewal' | 'extra';
  plan: string;
  status: OrderStatus;
  amountPaise: number;
  creditAppliedPaise: number;
  refundedPaise: number;
  createdAt: string;
  paidAt: string | null;
}

export interface RefundView {
  id: string;
  mobile: string;
  subscriptionId: string;
  orderId: string;
  amountPaise: number;
  breakdown: RefundBreakdown;
  method: 'razorpay' | 'manual_upi';
  status: RefundStatus;
  razorpayRefundId: string | null;
  upiId: string | null;
  utr: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreditView {
  id: string;
  amountPaise: number;
  kind: CreditEntry['kind'];
  refundable: boolean;
  note: string | null;
  actor: Actor;
  at: string;
}

export interface TicketView {
  id: string;
  mobile: string;
  kind: Ticket['kind'];
  status: Ticket['status'];
  channel: Ticket['channel'];
  note: string | null;
  photoUrl: string | null;
  resolution: string | null;
  resolvedBy: Actor | null;
  deliveryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageView {
  id: string;
  mobile: string;
  template: string;
  lang: string;
  status: MessageStatus;
  /** the rendered body, or null when it cannot be rendered (unknown template / missing params) */
  text: string | null;
  mediaUrl: string | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineItem {
  id: string;
  at: string;
  label: string;
  detail: string | null;
  who: string;
}

export interface CustomerDetail {
  mobile: string;
  profile: {
    exists: boolean;
    name: string | null;
    email: string | null;
    address: string | null;
    landmark: string | null;
    instructions: string | null;
    location: { lat: number; lng: number } | null;
    lang: 'en' | 'te';
    whatsappOptIn: boolean;
    whatsappOptInAt: string | null;
    missedDeliveryPreference: 'makeup_day' | 'credit';
    notifyDailyDelivered: boolean;
    createdAt: string | null;
    lastSeenAt: string | null;
  };
  firstOpenDate: string;
  plans: PlanView[];
  deliveries: DeliveryView[];
  orders: OrderView[];
  refunds: RefundView[];
  credit: { balancePaise: number; refundablePaise: number; history: CreditView[] };
  tickets: TicketView[];
  messages: MessageView[];
  timeline: TimelineItem[];
}

export function toRefundView(r: Refund): RefundView {
  return {
    id: hex(r._id),
    mobile: r.mobile,
    subscriptionId: hex(r.subscriptionId),
    orderId: hex(r.orderId),
    amountPaise: r.amountPaise,
    breakdown: r.breakdown,
    method: r.method,
    status: r.status,
    razorpayRefundId: r.razorpayRefundId ?? null,
    upiId: r.upiId ?? null,
    utr: r.utr ?? null,
    failureReason: r.failureReason ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toOrderView(o: Order): OrderView {
  return {
    id: hex(o._id),
    razorpayOrderId: o.razorpayOrderId,
    purpose: o.purpose ?? 'new',
    plan: orderPlanLabel(o),
    status: o.status,
    amountPaise: o.amountPaise,
    creditAppliedPaise: o.creditAppliedPaise ?? 0,
    refundedPaise: o.refundedPaise ?? 0,
    createdAt: o.createdAt.toISOString(),
    paidAt: iso(o.paidAt),
  };
}

export function toTicketView(t: Ticket): TicketView {
  return {
    id: hex(t._id),
    mobile: t.mobile,
    kind: t.kind,
    status: t.status,
    channel: t.channel,
    note: t.note ?? null,
    photoUrl: t.photoKey ? photoUrlFor(t.photoKey) : null,
    resolution: t.resolution ?? null,
    resolvedBy: t.resolvedBy ?? null,
    deliveryId: t.deliveryId ? hex(t.deliveryId) : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** The text the customer received (or would have), from the template registry. */
export function renderedText(m: Pick<OutboundMessage, 'template' | 'lang' | 'params'>): string | null {
  if (!isTemplateName(m.template)) return null;
  try {
    return render(m.template, m.lang, m.params);
  } catch {
    return null;
  }
}

export function toMessageView(m: OutboundMessage): MessageView {
  return {
    id: hex(m._id),
    mobile: m.mobile,
    template: m.template,
    lang: m.lang,
    status: m.status,
    text: renderedText(m),
    mediaUrl: m.mediaUrl ?? null,
    attempts: m.attempts,
    error: m.error ?? null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

/* ----------------------------------------------------------- timeline ---- */

const EVENT_LABEL: Record<string, string> = {
  'order.created': 'Checkout started',
  'order.paid': 'Payment received',
  'order.failed': 'Payment failed',
  'order.expired': 'Checkout expired unpaid',
  'order.refunded': 'Order fully refunded',
  'order.partially_refunded': 'Order partly refunded',
  'subscription.created': 'Plan created',
  'subscription.activated': 'Plan activated',
  'subscription.scheduled': 'Plan scheduled',
  'subscription.active': 'Plan started',
  'subscription.started': 'Plan started',
  'subscription.completed': 'Plan completed',
  'subscription.cancelled': 'Plan cancelled',
  'subscription.paused': 'Dates paused',
  'subscription.unpaused': 'Pause removed',
  'subscription.extended': 'Plan extended',
  'subscription.shortened': 'Plan shortened',
  'subscription.address_changed': 'Address changed',
  'subscription.renewal_linked': 'Renewal queued',
  'delivery.locked': 'Delivery locked for the route',
  'delivery.out_for_delivery': 'Out for delivery',
  'delivery.delivered': 'Delivered',
  'delivery.not_delivered': 'Not delivered',
  'delivery.unconfirmed': 'Delivery unconfirmed at day close',
  'delivery.cancelled': 'Delivery cancelled',
  'delivery.fault_set': 'Fault decided',
  'delivery.compensated': 'Missed delivery compensated',
  'refund.created': 'Refund created',
  'refund.processing': 'Refund sent to Razorpay',
  'refund.processed': 'Refund completed',
  'refund.failed': 'Refund failed',
  'refund.awaiting_upi': 'Refund waiting for a UPI id',
  'refund.paid_manually': 'Refund paid by UPI',
  'refund.upi_set': 'Customer gave a UPI id',
  'credit.goodwill': 'Goodwill credit',
  'credit.missed_delivery': 'Credit for a missed delivery',
  'credit.makeup_spend': 'Credit used',
  'credit.extra_spend': 'Credit used for an extra',
  'credit.order_spend': 'Credit used at checkout',
  'credit.order_spend_reversal': 'Credit returned (order not paid)',
  'credit.refund_payout': 'Credit paid out in a refund',
  'credit.cancellation_balance': 'Cancellation balance returned to credit',
  'credit.adjustment': 'Credit adjusted',
  'customer.whatsapp_opt_in': 'WhatsApp turned on',
  'customer.whatsapp_opt_out': 'WhatsApp turned off',
  'ticket.created': 'Issue reported',
  'ticket.resolved': 'Issue resolved',
};

function humanize(type: string): string {
  const [entity = '', verb = ''] = type.split('.');
  const s = `${entity} ${verb.replace(/_/g, ' ')}`.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function actorLabel(a: Actor | undefined | null): string {
  if (!a) return '—';
  if (a.kind === 'customer') return 'Customer';
  if (a.kind === 'staff') return `Staff ${a.id}`;
  if (a.kind === 'rider') return `Rider ${a.id}`;
  return a.id && a.id !== 'system' ? `System (${a.id.replace(/_/g, ' ')})` : 'System';
}

export function eventToTimeline(e: DomainEvent): TimelineItem {
  const bits: string[] = [];
  const d = e.data ?? {};
  const amount = (d as { amountPaise?: unknown }).amountPaise;
  if (typeof amount === 'number') bits.push(formatINR(Math.abs(amount)));
  if (e.from && e.to) bits.push(`${e.from.replace(/_/g, ' ')} → ${e.to.replace(/_/g, ' ')}`);
  if (e.reason) bits.push(`“${e.reason}”`);
  const dates = (d as { dates?: unknown }).dates;
  if (Array.isArray(dates) && dates.every(x => typeof x === 'string')) bits.push((dates as string[]).join(', '));
  const date = (d as { date?: unknown }).date;
  if (typeof date === 'string') bits.push(date);
  return {
    id: hex(e._id),
    at: e.at.toISOString(),
    label: EVENT_LABEL[e.type] ?? humanize(e.type),
    detail: bits.length ? bits.join(' · ') : null,
    who: actorLabel(e.actor),
  };
}

/**
 * Everything ops need about one customer. Null when the mobile has no user, no
 * plan and no order (the page answers 404).
 */
export async function customerDetail(mobileRaw: string, ctx: OpCtx): Promise<CustomerDetail | null> {
  const mobile = normalizeMobile(mobileRaw);
  if (!mobile) return null;
  const db = await getDb();

  const [user, subs, orders] = await Promise.all([
    col.users(db).findOne({ mobile }),
    col.subscriptions(db).find({ mobile }).sort({ createdAt: -1 }).limit(50).toArray(),
    col.orders(db).find({ mobile }).sort({ createdAt: -1 }).limit(50).toArray(),
  ]);
  if (!user && !subs.length && !orders.length) return null;

  const firstOpen = await firstOpenDateNow(ctx, db);
  const liveIds = subs.filter(s => s.status === 'active' || s.status === 'scheduled' || s.status === 'paused').map(s => s._id!);

  const [pausable, paused, deliveries, refunds, creditRows, history, tickets, messages, events] = await Promise.all([
    liveIds.length
      ? col
          .deliveries(db)
          .find(
            { subscriptionId: { $in: liveIds }, source: 'plan', status: 'planned', date: { $gte: firstOpen } },
            { projection: { subscriptionId: 1, date: 1 } },
          )
          .sort({ date: 1 })
          .limit(liveIds.length * 60)
          .toArray()
      : Promise.resolve([]),
    liveIds.length
      ? col.pausedDates(db).find({ subscriptionId: { $in: liveIds }, date: { $gte: firstOpen } }).sort({ date: 1 }).toArray()
      : Promise.resolve([]),
    col.deliveries(db).find({ mobile }).sort({ date: -1 }).limit(60).toArray(),
    col.refunds(db).find({ mobile }).sort({ createdAt: -1 }).limit(50).toArray(),
    col.credits(db).find({ mobile }, { projection: { amountPaise: 1, kind: 1, refundable: 1, deliveryId: 1 } }).toArray(),
    col.credits(db).find({ mobile }).sort({ at: -1, _id: -1 }).limit(50).toArray(),
    listTickets({ mobile }, 50),
    col.outbox(db).find({ mobile }).sort({ _id: -1 }).limit(50).toArray(),
    customerTimeline(mobile, 100),
  ]);

  const pausableBy = new Map<string, string[]>();
  for (const r of pausable) {
    const k = hex(r.subscriptionId);
    const l = pausableBy.get(k) ?? [];
    if (l.length < 60) l.push(r.date);
    pausableBy.set(k, l);
  }
  const pausedBy = new Map<string, string[]>();
  for (const p of paused) {
    const k = hex(p.subscriptionId);
    const l = pausedBy.get(k) ?? [];
    l.push(p.date);
    pausedBy.set(k, l);
  }
  const bal = foldBalance(creditRows);

  return {
    mobile,
    profile: {
      exists: Boolean(user),
      name: user?.name ?? subs[0]?.name ?? null,
      email: user?.email ?? null,
      address: user?.address ?? null,
      landmark: user?.landmark ?? null,
      instructions: user?.instructions ?? null,
      location: user?.location ? { lat: user.location.lat, lng: user.location.lng } : null,
      lang: user?.lang ?? 'en',
      whatsappOptIn: user?.whatsappOptIn === true,
      whatsappOptInAt: iso(user?.whatsappOptInAt),
      missedDeliveryPreference: user?.missedDeliveryPreference ?? 'makeup_day',
      notifyDailyDelivered: user?.notifyDailyDelivered === true,
      createdAt: iso(user?.createdAt),
      lastSeenAt: iso(user?.lastSeenAt),
    },
    firstOpenDate: firstOpen,
    plans: subs.map(s => {
      const id = hex(s._id);
      return {
        id,
        label: subPlanLabel(s),
        status: s.status,
        startDate: s.startDate,
        endDate: s.endDate,
        daysTotal: s.daysTotal,
        daysDelivered: s.daysDelivered,
        pauseUsedDays: s.pauseUsedDays ?? 0,
        pauseAllowanceDays: s.pauseAllowanceDays ?? 0,
        name: s.name ?? null,
        address: s.address ?? null,
        landmark: s.landmark ?? null,
        instructions: s.instructions ?? null,
        location: s.location ? { lat: s.location.lat, lng: s.location.lng } : null,
        renewedBy: s.renewedBy ? hex(s.renewedBy) : null,
        renewalOf: s.renewalOf ? hex(s.renewalOf) : null,
        cancelledAt: iso(s.cancelledAt),
        cancelEffectiveDate: s.cancelEffectiveDate ?? null,
        cancelReason: s.cancelReason ?? null,
        cancelledBy: s.cancelledBy ?? null,
        refundId: s.refundId ? hex(s.refundId) : null,
        pausableDates: pausableBy.get(id) ?? [],
        pausedDates: pausedBy.get(id) ?? [],
      };
    }),
    deliveries: deliveries.map(d => ({
      id: hex(d._id),
      date: d.date,
      status: d.status,
      source: d.source ?? 'plan',
      kind: d.kind,
      litres: d.litres,
      reason: d.reason ?? null,
      reasonNote: d.reasonNote ?? null,
      fault: d.fault ?? null,
      resolution: d.resolution ?? null,
      deliveredAt: iso(d.deliveredAt),
      photoUrl: d.proof?.photoKey ? photoUrlFor(d.proof.photoKey) : null,
      flagged: d.proof?.flagged === true && !d.proof.flagClearedAt,
      note: d.note ?? null,
    })),
    orders: orders.map(toOrderView),
    refunds: refunds.map(toRefundView),
    credit: {
      balancePaise: bal.balancePaise,
      refundablePaise: bal.refundablePaise,
      history: history.map(c => ({
        id: hex(c._id),
        amountPaise: c.amountPaise,
        kind: c.kind,
        refundable: c.refundable,
        note: c.note ?? null,
        actor: c.actor,
        at: c.at.toISOString(),
      })),
    },
    tickets: tickets.map(toTicketView),
    messages: messages.map(toMessageView),
    timeline: events.map(eventToTimeline),
  };
}

/**
 * The subscription `id`, only when it belongs to `mobile` — otherwise NotFoundError
 * (a staff action addressed through the wrong customer must not touch anything).
 */
export async function subscriptionOfCustomer(mobileRaw: string, idRaw: string): Promise<Subscription & { _id: ObjectId }> {
  const mobile = normalizeMobile(mobileRaw);
  if (!mobile || !/^[a-f0-9]{24}$/i.test(idRaw)) throw new NotFoundError('Plan not found for this customer');
  const db = await getDb();
  const sub = await col.subscriptions(db).findOne({ _id: new ObjectId(idRaw), mobile });
  if (!sub?._id) throw new NotFoundError('Plan not found for this customer');
  return sub as Subscription & { _id: ObjectId };
}

/* -------------------------------------------------------------- orders ---- */

export const ORDER_STATUSES: readonly OrderStatus[] = ['created', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded'];
export const ORDER_PAGE = 50;

export interface OrderListRow extends OrderView {
  mobile: string;
  name: string | null;
}

export async function listOrders(opts: { status?: OrderStatus; cursor?: string }): Promise<{ orders: OrderListRow[]; nextCursor: string | null }> {
  const q: Filter<Order> = {};
  if (opts.status) {
    if (!ORDER_STATUSES.includes(opts.status)) throw new ValidationError('Unknown status', [`status must be one of ${ORDER_STATUSES.join(', ')}`]);
    q.status = opts.status;
  }
  if (opts.cursor) {
    if (!/^[a-f0-9]{24}$/i.test(opts.cursor)) throw new ValidationError('Invalid cursor');
    q._id = { $lt: new ObjectId(opts.cursor) };
  }
  const db = await getDb();
  const rows = await col.orders(db).find(q).sort({ _id: -1 }).limit(ORDER_PAGE).toArray();
  const nextCursor = rows.length === ORDER_PAGE ? hex(rows[rows.length - 1]?._id) || null : null;
  return { orders: rows.map(o => ({ ...toOrderView(o), mobile: o.mobile, name: o.name ?? null })), nextCursor };
}

export const ABANDONED_LOOKBACK_DAYS = 30;

export interface AbandonedRow {
  orderId: string;
  mobile: string;
  name: string | null;
  plan: string;
  amountPaise: number;
  status: 'created' | 'expired';
  createdAt: string;
  /** how many unpaid attempts this mobile made in the window */
  attempts: number;
}

/**
 * Checkouts that never turned into money: 'created' or 'expired' orders (last
 * ABANDONED_LOOKBACK_DAYS days) whose mobile has NO paid order created after them.
 * One row per mobile (the latest attempt), newest first — a call list.
 * 'failed' is left out: the payment was attempted and the gateway said no, which is
 * a different conversation (and shows under Orders → Failed).
 */
export async function abandonedCheckouts(ctx: OpCtx): Promise<AbandonedRow[]> {
  const db = await getDb();
  const since = new Date(ctx.now.getTime() - ABANDONED_LOOKBACK_DAYS * 86_400_000);
  const unpaid = await col
    .orders(db)
    .find({ status: { $in: ['created', 'expired'] }, createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(500)
    .toArray();
  if (!unpaid.length) return [];
  const mobiles = [...new Set(unpaid.map(o => o.mobile))];
  const paid = await col
    .orders(db)
    .find(
      { mobile: { $in: mobiles }, status: { $in: ['paid', 'partially_refunded', 'refunded'] } },
      { projection: { mobile: 1, createdAt: 1 } },
    )
    .toArray();
  const lastPaid = new Map<string, number>();
  for (const p of paid) {
    const t = p.createdAt.getTime();
    if (t > (lastPaid.get(p.mobile) ?? -Infinity)) lastPaid.set(p.mobile, t);
  }
  const out = new Map<string, AbandonedRow>();
  for (const o of unpaid) {
    const lp = lastPaid.get(o.mobile);
    if (lp !== undefined && lp > o.createdAt.getTime()) continue; // they came back and paid
    const have = out.get(o.mobile);
    if (have) {
      have.attempts += 1;
      continue;
    }
    out.set(o.mobile, {
      orderId: hex(o._id),
      mobile: o.mobile,
      name: o.name ?? null,
      plan: orderPlanLabel(o),
      amountPaise: o.amountPaise,
      status: o.status === 'created' ? 'created' : 'expired',
      createdAt: o.createdAt.toISOString(),
      attempts: 1,
    });
  }
  return [...out.values()];
}

/* ------------------------------------------------------------- refunds ---- */

export const REFUND_STATUSES: readonly RefundStatus[] = ['pending', 'processing', 'processed', 'failed', 'awaiting_upi', 'paid_manually'];

export interface RefundListRow extends RefundView {
  name: string | null;
}

/** Same read as GET /api/admin/refunds (newest first, up to 200), plus the customer name. */
export async function listRefunds(status?: RefundStatus): Promise<RefundListRow[]> {
  if (status && !REFUND_STATUSES.includes(status)) throw new ValidationError('Unknown status');
  const db = await getDb();
  const rows = await col.refunds(db).find(status ? { status } : {}).sort({ createdAt: -1 }).limit(200).toArray();
  const names = await namesFor(rows.map(r => r.mobile));
  return rows.map(r => ({ ...toRefundView(r), name: names.get(r.mobile) ?? null }));
}

async function namesFor(mobilesRaw: string[]): Promise<Map<string, string>> {
  const mobiles = [...new Set(mobilesRaw)];
  const out = new Map<string, string>();
  if (!mobiles.length) return out;
  const db = await getDb();
  for (const u of await col.users(db).find({ mobile: { $in: mobiles } }, { projection: { mobile: 1, name: 1 } }).toArray()) {
    if (u.name) out.set(u.mobile, u.name);
  }
  return out;
}

/* ------------------------------------------------------- subscriptions ---- */

export const SUB_STATUSES: readonly SubStatus[] = ['scheduled', 'active', 'completed', 'cancelled', 'paused'];

export interface SubscriptionFilters {
  status?: SubStatus;
  /** scheduled/active plans whose endDate is within this many days of today */
  endingWithin?: 7 | 14;
  /** 'queued' = a renewal is linked; 'none' = no renewal yet */
  renewal?: 'queued' | 'none';
}

export interface SubscriptionListRow {
  id: string;
  mobile: string;
  name: string | null;
  label: string;
  status: SubStatus;
  startDate: string;
  endDate: string;
  daysDelivered: number;
  daysTotal: number;
  renewedBy: string | null;
  address: string | null;
}

export const SUB_LIST_LIMIT = 200;

export async function listSubscriptions(f: SubscriptionFilters, ctx: OpCtx): Promise<{ rows: SubscriptionListRow[]; truncated: boolean }> {
  const q: Filter<Subscription> = {};
  if (f.status) {
    if (!SUB_STATUSES.includes(f.status)) throw new ValidationError('Unknown status');
    q.status = f.status;
  }
  if (f.endingWithin) {
    const today = istYMD(ctx.now);
    q.endDate = { $gte: today, $lte: addDaysYMD(today, f.endingWithin) };
    if (!f.status) q.status = { $in: ['scheduled', 'active'] };
  }
  if (f.renewal === 'queued') q.renewedBy = { $exists: true };
  if (f.renewal === 'none') q.renewedBy = { $exists: false };
  const db = await getDb();
  const sort: Record<string, 1 | -1> = f.endingWithin ? { endDate: 1 } : { createdAt: -1 };
  const rows = await col.subscriptions(db).find(q).sort(sort).limit(SUB_LIST_LIMIT + 1).toArray();
  const truncated = rows.length > SUB_LIST_LIMIT;
  const page = rows.slice(0, SUB_LIST_LIMIT);
  const names = await namesFor(page.map(s => s.mobile));
  return {
    truncated,
    rows: page.map(s => ({
      id: hex(s._id),
      mobile: s.mobile,
      name: s.name ?? names.get(s.mobile) ?? null,
      label: subPlanLabel(s),
      status: s.status,
      startDate: s.startDate,
      endDate: s.endDate,
      daysDelivered: s.daysDelivered,
      daysTotal: s.daysTotal,
      renewedBy: s.renewedBy ? hex(s.renewedBy) : null,
      address: s.address ?? null,
    })),
  };
}

/* ------------------------------------------------------------ messages ---- */

export const MESSAGE_STATUSES: readonly MessageStatus[] = ['queued', 'sent', 'delivered', 'read', 'failed', 'logged', 'suppressed'];

/** Same filters as GET /api/admin/messages, with the rendered text. */
export async function listOutbox(f: { status?: MessageStatus; template?: string; mobile?: string; cursor?: string }): Promise<{
  messages: MessageView[];
  nextCursor: string | null;
}> {
  const q: Filter<OutboundMessage> = {};
  if (f.status) {
    if (!MESSAGE_STATUSES.includes(f.status)) throw new ValidationError('Unknown status');
    q.status = f.status;
  }
  if (f.template) q.template = f.template;
  if (f.mobile) {
    const m = normalizeMobile(f.mobile);
    if (!m) throw new ValidationError('Invalid mobile');
    q.mobile = m;
  }
  if (f.cursor) {
    if (!/^[a-f0-9]{24}$/i.test(f.cursor)) throw new ValidationError('Invalid cursor');
    q._id = { $lt: new ObjectId(f.cursor) };
  }
  const db = await getDb();
  const rows = await col.outbox(db).find(q).sort({ _id: -1 }).limit(50).toArray();
  return { messages: rows.map(toMessageView), nextCursor: rows.length === 50 ? hex(rows[rows.length - 1]?._id) || null : null };
}

/* --------------------------------------------------------------- staff ---- */

export const STAFF_ROLES: readonly StaffRole[] = ['owner', 'ops', 'support'];

export interface StaffRow {
  mobile: string;
  name: string;
  role: StaffRole;
  active: boolean;
  /** from the ADMIN_MOBILES env allowlist — fixed, cannot be edited from the UI */
  envOwner: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export async function listStaff(): Promise<StaffRow[]> {
  const env = adminMobiles();
  const db = await getDb();
  const rows = await col.staff(db).find({}).sort({ active: -1, role: 1, name: 1 }).toArray();
  const byMobile = new Map(rows.map(r => [r.mobile, r]));
  const envRows: StaffRow[] = env.map(m => {
    const r = byMobile.get(m);
    return {
      mobile: m,
      name: r?.name ?? 'Owner (env)',
      role: 'owner',
      active: true,
      envOwner: true,
      createdAt: iso(r?.createdAt),
      updatedAt: iso(r?.updatedAt),
    };
  });
  const rest: StaffRow[] = rows
    .filter(r => !env.includes(r.mobile))
    .map(r => ({
      mobile: r.mobile,
      name: r.name,
      role: r.role,
      active: r.active,
      envOwner: false,
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    }));
  return [...envRows, ...rest];
}

function staffEvent(ctx: OpCtx, mobile: string, type: string, extra: { from?: string; to?: string; data?: Record<string, unknown> }) {
  return recordEvent(ctx, { entity: 'staff', entityId: mobile, type, ...extra });
}

function parseName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (name.length < 2 || name.length > 60) throw new ValidationError('Invalid staff member', ['name must be 2–60 characters']);
  return name;
}

function parseRole(v: unknown): StaffRole {
  if (typeof v !== 'string' || !STAFF_ROLES.includes(v as StaffRole)) {
    throw new ValidationError('Invalid staff member', [`role must be one of ${STAFF_ROLES.join(', ')}`]);
  }
  return v as StaffRole;
}

/** Add a staff member. 409 when the mobile is already staff (active or not) or an env owner. */
export async function addStaff(input: { mobile: unknown; name: unknown; role: unknown }, ctx: OpCtx): Promise<StaffRow> {
  const mobile = typeof input.mobile === 'string' ? normalizeMobile(input.mobile) : null;
  const issues: string[] = [];
  if (!mobile) issues.push('mobile must be a 10-digit Indian mobile');
  if (issues.length || !mobile) throw new ValidationError('Invalid staff member', issues);
  const name = parseName(input.name);
  const role = parseRole(input.role);
  if (adminMobiles().includes(mobile)) throw new ConflictError('That number is already an owner (set in the server configuration).');

  const db = await getDb();
  const doc: Staff = { mobile, name, role, active: true, createdAt: ctx.now, updatedAt: ctx.now };
  try {
    await col.staff(db).insertOne(doc);
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      throw new ConflictError('That number is already on the staff list — change it there (or reactivate it).');
    }
    throw err;
  }
  await staffEvent(ctx, mobile, 'staff.added', { to: role, data: { name, role } });
  return { mobile, name, role, active: true, envOwner: false, createdAt: ctx.now.toISOString(), updatedAt: ctx.now.toISOString() };
}

/**
 * Change a staff member's role, name or active flag. Env owners cannot be edited;
 * nobody can deactivate or demote themselves (so an owner can never lock the
 * business out of its own admin by accident).
 */
export async function updateStaff(
  mobileRaw: string,
  patch: { role?: unknown; active?: unknown; name?: unknown },
  actorMobile: string,
  ctx: OpCtx,
): Promise<StaffRow> {
  const mobile = normalizeMobile(mobileRaw);
  if (!mobile) throw new NotFoundError('Staff member not found');
  if (adminMobiles().includes(mobile)) throw new ForbiddenError('Owners set in the server configuration cannot be changed here.');

  const role = patch.role !== undefined ? parseRole(patch.role) : undefined;
  const name = patch.name !== undefined ? parseName(patch.name) : undefined;
  if (patch.active !== undefined && typeof patch.active !== 'boolean') throw new ValidationError('Invalid change', ['active must be true or false']);
  const active = patch.active as boolean | undefined;
  if (role === undefined && name === undefined && active === undefined) throw new ValidationError('Nothing to change', ['send role, name or active']);

  const db = await getDb();
  const cur = await col.staff(db).findOne({ mobile });
  if (!cur) throw new NotFoundError('Staff member not found');

  if (mobile === actorMobile) {
    if (active === false) throw new ForbiddenError('You cannot deactivate yourself.');
    if (role !== undefined && role !== cur.role) throw new ForbiddenError('You cannot change your own role.');
  }

  const set: Partial<Staff> = { updatedAt: ctx.now };
  if (role !== undefined) set.role = role;
  if (name !== undefined) set.name = name;
  if (active !== undefined) set.active = active;
  // conditional on what we read, so two owners editing at once cannot both win silently
  const res = await col.staff(db).findOneAndUpdate(
    { mobile, role: cur.role, active: cur.active, name: cur.name },
    { $set: set },
    { returnDocument: 'after' },
  );
  if (!res) throw new ConflictError('Someone else changed this staff member — reload and try again.');

  if (role !== undefined && role !== cur.role) await staffEvent(ctx, mobile, 'staff.role_changed', { from: cur.role, to: role });
  if (active !== undefined && active !== cur.active) {
    await staffEvent(ctx, mobile, active ? 'staff.reactivated' : 'staff.deactivated', {
      from: cur.active ? 'active' : 'inactive',
      to: active ? 'active' : 'inactive',
    });
  }
  if (name !== undefined && name !== cur.name) await staffEvent(ctx, mobile, 'staff.renamed', { data: { from: cur.name, to: name } });

  return {
    mobile,
    name: res.name,
    role: res.role,
    active: res.active,
    envOwner: false,
    createdAt: iso(res.createdAt),
    updatedAt: iso(res.updatedAt),
  };
}
