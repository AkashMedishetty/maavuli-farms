/**
 * Orders: checkout creation, payment state, activation dispatch, expiry.
 *
 * OWNER: B1 (subscriptions & orders). The signatures below are the contract other
 * agents code against — keep them.
 *
 * Ordering inside createCheckoutOrder is deliberate:
 *   validate → idempotency lookup → spend credit (against a pre-generated _id) →
 *   Razorpay order (only when something is payable) → insert.
 * A failure after the spend reverses it, so a crashed checkout never eats credit.
 */

import { MongoServerError, ObjectId } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { getDb } from './db';
import { col, normalizeMobile, type DeliveryDetails, type MilkKind, type Order, type User } from './models';
import type { OpCtx } from './clock';
import { PRODUCTS, QUANTITIES, TENURES, formatINR, quote, type Quote } from './pricing';
import { ConflictError, NotFoundError, ServiceNotConfiguredError, UpstreamError, ValidationError } from './errors';
import { assertTransition, ORDER_TRANSITIONS } from './transitions';
import { recordEvent } from './events';
import { firstOpenDateNow } from './daylock';
import { addDaysYMD, isYMD, istYMD } from './cutoff';
import { normalizePoint } from './geo';
import { zoneForPoint } from './serviceability';
import { creditBalance, reverseOrderSpend, spendCredit } from './credits';
import { createOrder as razorpayCreateOrder, type CreateOrderInput, type RazorpayOrder } from './razorpay';
import { razorpayConfig } from './env';
import { activateSubscriptionForOrder, renewalTarget } from './subscriptions';
import { activateExtraOrder } from './extras';
import { enqueueMessage } from './notify';
import { setWhatsappOptIn } from './notify/optin';
import { getOpsSettings } from './settings';

export interface CheckoutInput {
  /** always the SESSION mobile — never taken from the request body */
  mobile: string;
  purpose: 'new' | 'renewal';
  kind: MilkKind;
  quantityId: string;
  tenureId: string;
  /** requested first delivery; clamped to the first open date (renewals: day after the renewed plan ends) */
  startDate?: string;
  /** purpose 'renewal' */
  renewsSubscriptionId?: ObjectId;
  /** location REQUIRED */
  details: DeliveryDetails;
  useCredit: boolean;
  /**
   * The checkout's WhatsApp checkbox. undefined = the form did not show it / the
   * customer did not touch it → the stored preference is left as it is. Only an
   * explicit true/false changes it (an unticked box must never silently opt a
   * returning customer out).
   */
  whatsappOptIn?: boolean;
  /** client UUID per checkout attempt — a retry with the same key returns the same order */
  idempotencyKey: string;
}

export interface CheckoutPreview {
  amountPaise: number;
  originalPaise: number;
  savingPaise: number;
  perLitrePaise: number;
  days: number;
  litres: number;
  /** the first delivery date this order would get */
  startDate: string;
  endDate: string;
  firstOpenDate: string;
  creditAvailablePaise: number;
  creditAppliedPaise: number;
  payablePaise: number;
}

export interface CheckoutResult {
  order: Order & { _id: ObjectId };
  /** null when the order was paid entirely from credit (already paid + activated) */
  razorpay: { orderId: string; keyId: string; amountPaise: number } | null;
  preview: CheckoutPreview;
}

/** A requested start date may be at most this many days after today (IST). */
export const MAX_START_DAYS_AHEAD = 30;

/* ------------------------------------------------------ test seam (IT only) -- */

type CreateOrderImpl = (input: CreateOrderInput) => Promise<RazorpayOrder>;
let createOrderOverride: CreateOrderImpl | undefined;

/**
 * Integration tests only: replace the Razorpay createOrder call (and skip the
 * config check) so the paid path can run without real credentials. Never set in app code.
 */
export function __setRazorpayCreateOrderForTests(f: CreateOrderImpl | undefined): void {
  createOrderOverride = f;
}

function razorpayKeyId(): string {
  if (createOrderOverride) return 'rzp_test_fake';
  const cfg = razorpayConfig();
  if (!cfg.ok) throw new ServiceNotConfiguredError('Razorpay', cfg.missing);
  return cfg.value.RAZORPAY_KEY_ID;
}

/* ---------------------------------------------------------------- helpers -- */

function quoteOrThrow(kind: MilkKind, quantityId: string, tenureId: string): Quote {
  if (kind !== 'cow' && kind !== 'buffalo') throw new ValidationError('Invalid milk kind', [], 'plan_invalid');
  try {
    return quote(kind, quantityId, tenureId);
  } catch {
    throw new ValidationError('Invalid plan selection', [], 'plan_invalid');
  }
}

function planLabel(o: Pick<Order, 'kind' | 'quantityId' | 'tenureId'>): string {
  const p = PRODUCTS.find(x => x.kind === o.kind)?.label ?? o.kind;
  const q = QUANTITIES.find(x => x.id === o.quantityId)?.label ?? o.quantityId;
  const t = TENURES.find(x => x.id === o.tenureId)?.label ?? o.tenureId;
  return `${p} · ${q} · ${t}`;
}

/** "Thu 2 Oct" — for message params. */
function humanDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  );
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

interface ResolvedStart {
  startDate: string;
  firstOpenDate: string;
}

/**
 * The first delivery date an order would get right now. New plans: max(requested,
 * first open), requested ≤ 30 days out. Renewals: the day after the renewed plan's
 * end (or first open if that has passed) — the requested date is ignored.
 */
async function resolveStart(
  input: { mobile: string; purpose: 'new' | 'renewal'; startDate?: string; renewsSubscriptionId?: ObjectId },
  ctx: OpCtx,
): Promise<ResolvedStart> {
  const firstOpen = await firstOpenDateNow(ctx);
  if (input.purpose === 'renewal') {
    if (!input.renewsSubscriptionId) throw new ValidationError('renewsSubscriptionId is required for a renewal', [], 'not_renewable');
    const m = normalizeMobile(input.mobile);
    if (!m) throw new ValidationError('Sign in to renew a plan', [], 'not_renewable');
    const target = await renewalTarget(m, input.renewsSubscriptionId, ctx);
    if (!target) {
      throw new ValidationError(
        'That plan cannot be renewed',
        ['The plan must be yours, scheduled or active, and not already renewed.'],
        'not_renewable',
      );
    }
    return { startDate: target.renewStartDate, firstOpenDate: firstOpen };
  }
  let startDate = firstOpen;
  if (input.startDate !== undefined) {
    if (!isYMD(input.startDate)) throw new ValidationError('startDate must be YYYY-MM-DD', [], 'start_invalid');
    const latest = addDaysYMD(istYMD(ctx.now), MAX_START_DAYS_AHEAD);
    if (input.startDate > latest) {
      throw new ValidationError(`The first delivery can be at most ${MAX_START_DAYS_AHEAD} days away (${latest}).`, [], 'start_invalid');
    }
    if (input.startDate > firstOpen) startDate = input.startDate;
  }
  return { startDate, firstOpenDate: firstOpen };
}

async function availableCredit(mobile: string): Promise<number> {
  const m = normalizeMobile(mobile);
  if (!m) return 0;
  const { balancePaise } = await creditBalance(m);
  return Math.max(0, balancePaise);
}

/* ---------------------------------------------------------------- preview -- */

export async function previewCheckout(
  input: Omit<CheckoutInput, 'details' | 'whatsappOptIn' | 'idempotencyKey'>,
  ctx: OpCtx,
): Promise<CheckoutPreview> {
  const q = quoteOrThrow(input.kind, input.quantityId, input.tenureId);
  const { startDate, firstOpenDate } = await resolveStart(input, ctx);
  const creditAvailablePaise = await availableCredit(input.mobile);
  const creditAppliedPaise = input.useCredit ? Math.min(creditAvailablePaise, q.finalPaise) : 0;
  return {
    amountPaise: q.finalPaise,
    originalPaise: q.originalPaise,
    savingPaise: q.savingPaise,
    perLitrePaise: q.perLitrePaise,
    days: q.days,
    litres: q.litres,
    startDate,
    endDate: addDaysYMD(startDate, q.days - 1),
    firstOpenDate,
    creditAvailablePaise,
    creditAppliedPaise,
    payablePaise: q.finalPaise - creditAppliedPaise,
  };
}

/* ---------------------------------------------------------------- create -- */

function sameRequest(o: Order, input: CheckoutInput): boolean {
  return (
    (o.purpose ?? 'new') === input.purpose &&
    o.kind === input.kind &&
    o.quantityId === input.quantityId &&
    o.tenureId === input.tenureId &&
    (o.renewsSubscriptionId?.toHexString() ?? null) === (input.renewsSubscriptionId?.toHexString() ?? null)
  );
}

function previewFromOrder(o: Order, firstOpenDate: string): CheckoutPreview {
  const q = quote(o.kind, o.quantityId, o.tenureId);
  const start = o.startDate ?? firstOpenDate;
  const applied = o.creditAppliedPaise ?? 0;
  return {
    amountPaise: o.amountPaise,
    originalPaise: q.originalPaise,
    savingPaise: q.originalPaise - o.amountPaise,
    perLitrePaise: o.perLitrePaise,
    days: o.days,
    litres: o.litres,
    startDate: start,
    endDate: addDaysYMD(start, o.days - 1),
    firstOpenDate,
    creditAvailablePaise: 0,
    creditAppliedPaise: applied,
    payablePaise: o.payablePaise ?? o.amountPaise - applied,
  };
}

async function existingResult(o: Order & { _id: ObjectId }, ctx: OpCtx): Promise<CheckoutResult> {
  const firstOpen = await firstOpenDateNow(ctx);
  const payable = o.payablePaise ?? o.amountPaise - (o.creditAppliedPaise ?? 0);
  const razorpay =
    o.razorpayOrderId.startsWith('credit_') || o.status === 'paid'
      ? null
      : { orderId: o.razorpayOrderId, keyId: razorpayKeyId(), amountPaise: payable };
  return { order: o, razorpay, preview: previewFromOrder(o, firstOpen) };
}

function validateDetails(d: DeliveryDetails): { name: string; address: string; location: { lat: number; lng: number } } {
  const issues: string[] = [];
  const name = typeof d?.name === 'string' ? d.name.trim() : '';
  if (name.length < 2) issues.push('A name for the delivery is required');
  const address = typeof d?.address === 'string' ? d.address.trim() : '';
  if (address.length < 10) issues.push('A delivery address is required (flat or house, street and area)');
  const point = d?.location ? normalizePoint(d.location.lat, d.location.lng) : null;
  if (!point) issues.push('Drop a pin on the map for the exact doorstep');
  if (issues.length || !point) throw new ValidationError('Delivery details are incomplete', issues, 'details_incomplete');
  return { name, address, location: point };
}

function optStr(v: unknown, max = 300): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

export async function createCheckoutOrder(input: CheckoutInput, ctx: OpCtx): Promise<CheckoutResult> {
  const mobile = normalizeMobile(input.mobile);
  if (!mobile) throw new ValidationError('Invalid mobile number');
  const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (key.length < 8 || key.length > 100) throw new ValidationError('idempotencyKey must be 8–100 characters');
  if (input.purpose !== 'new' && input.purpose !== 'renewal') throw new ValidationError('Invalid purpose');

  const db = await getDb();

  // Idempotency first: a retry returns the same order and never re-spends credit.
  const prior = await col.orders(db).findOne({ idempotencyKey: key });
  if (prior?._id) {
    if (prior.mobile !== mobile || !sameRequest(prior, input)) {
      throw new ConflictError('This checkout key was already used for a different order.');
    }
    return existingResult(prior as Order & { _id: ObjectId }, ctx);
  }

  const q = quoteOrThrow(input.kind, input.quantityId, input.tenureId);
  const det = validateDetails(input.details);
  const zone = await zoneForPoint(det.location);
  if (!zone) {
    throw new ValidationError(
      'That address is outside our delivery area at the moment.',
      ['The pin is not inside any active delivery zone.'],
      'outside_zone',
    );
  }
  const { startDate, firstOpenDate } = await resolveStart({ ...input, mobile }, ctx);

  const creditAvailablePaise = input.useCredit ? await availableCredit(mobile) : 0;
  const creditAppliedPaise = input.useCredit ? Math.min(creditAvailablePaise, q.finalPaise) : 0;
  const payablePaise = q.finalPaise - creditAppliedPaise;

  // Fail on missing Razorpay config BEFORE touching credit.
  const keyId = payablePaise > 0 ? razorpayKeyId() : null;

  const orderId = new ObjectId();
  if (creditAppliedPaise > 0) {
    await spendCredit(mobile, creditAppliedPaise, 'order_spend', { orderId, note: `checkout ${input.purpose}` }, ctx);
  }

  let razorpayOrderId: string;
  try {
    if (payablePaise > 0) {
      const rz = await (createOrderOverride ?? razorpayCreateOrder)({
        amountPaise: payablePaise,
        receipt: `mvl_${orderId.toHexString()}`,
        notes: { mobile, orderId: orderId.toHexString(), purpose: input.purpose },
      });
      razorpayOrderId = rz.id;
    } else {
      razorpayOrderId = `credit_${randomBytes(12).toString('hex')}`;
    }
  } catch (err) {
    if (creditAppliedPaise > 0) await reverseOrderSpend(orderId, ctx);
    if (err instanceof ServiceNotConfiguredError) throw err;
    // eslint-disable-next-line no-console
    console.error('[checkout] razorpay order failed', err instanceof Error ? err.message : err);
    throw new UpstreamError('razorpay', 'Could not start the payment. Please try again.');
  }

  const addressParts = input.details.addressParts;
  const landmark = optStr(input.details.landmark);
  const instructions = optStr(input.details.instructions, 500);
  const pincode = addressParts?.pincode && /^\d{6}$/.test(addressParts.pincode) ? addressParts.pincode : '';

  const doc: Order & { _id: ObjectId } = {
    _id: orderId,
    razorpayOrderId,
    mobile,
    purpose: input.purpose,
    kind: input.kind,
    quantityId: q.quantityId,
    tenureId: q.tenureId,
    amountPaise: q.finalPaise,
    perLitrePaise: q.perLitrePaise,
    days: q.days,
    litres: q.litres,
    pincode,
    creditAppliedPaise,
    payablePaise,
    idempotencyKey: key,
    startDate,
    ...(input.purpose === 'renewal' && input.renewsSubscriptionId
      ? { renewsSubscriptionId: input.renewsSubscriptionId }
      : {}),
    name: det.name,
    address: det.address,
    location: det.location,
    ...(landmark ? { landmark } : {}),
    ...(instructions ? { instructions } : {}),
    ...(addressParts ? { addressParts } : {}),
    ...(input.whatsappOptIn !== undefined ? { whatsappOptIn: input.whatsappOptIn } : {}),
    status: 'created',
    createdAt: ctx.now,
  };

  try {
    await col.orders(db).insertOne(doc);
  } catch (err) {
    if (!isDuplicateKey(err)) {
      if (creditAppliedPaise > 0) await reverseOrderSpend(orderId, ctx);
      throw err;
    }
    // Lost an idempotency race with a concurrent identical submit: undo our spend,
    // answer with the winner.
    if (creditAppliedPaise > 0) await reverseOrderSpend(orderId, ctx);
    const winner = await col.orders(db).findOne({ idempotencyKey: key });
    if (!winner?._id || winner.mobile !== mobile || !sameRequest(winner, input)) {
      throw new ConflictError('This checkout key was already used for a different order.');
    }
    return existingResult(winner as Order & { _id: ObjectId }, ctx);
  }

  await recordEvent(ctx, {
    entity: 'order',
    entityId: orderId.toHexString(),
    type: 'order.created',
    to: 'created',
    mobile,
    data: { purpose: input.purpose, amountPaise: q.finalPaise, creditAppliedPaise, payablePaise, startDate },
  }, db);

  // Remember ONLY the session user's own delivery profile.
  const userSet: Partial<User> = {
    name: det.name,
    address: det.address,
    location: det.location,
    lastSeenAt: ctx.now,
    ...(addressParts ? { addressParts } : {}),
    ...(landmark ? { landmark } : {}),
    ...(instructions ? { instructions } : {}),
    ...(pincode ? { pincode } : {}),
  };
  await col.users(db).updateOne(
    { mobile },
    { $set: userSet, $setOnInsert: { mobile, createdAt: ctx.now } },
    { upsert: true },
  );
  // Consent goes through the one audited writer, and only when the customer
  // actually expressed a choice at this checkout.
  if (input.whatsappOptIn !== undefined) {
    await setWhatsappOptIn(mobile, input.whatsappOptIn, 'checkout', ctx);
  }

  const preview: CheckoutPreview = {
    amountPaise: q.finalPaise,
    originalPaise: q.originalPaise,
    savingPaise: q.savingPaise,
    perLitrePaise: q.perLitrePaise,
    days: q.days,
    litres: q.litres,
    startDate,
    endDate: addDaysYMD(startDate, q.days - 1),
    firstOpenDate,
    creditAvailablePaise,
    creditAppliedPaise,
    payablePaise,
  };

  if (payablePaise === 0) {
    const paid = await markOrderPaid(orderId, { source: 'credit' }, ctx);
    return { order: { ...paid, _id: orderId }, razorpay: null, preview };
  }
  return { order: doc, razorpay: { orderId: razorpayOrderId, keyId: keyId!, amountPaise: payablePaise }, preview };
}

/* ------------------------------------------------------------ payment state -- */

/**
 * created|failed|expired → paid, then activateOrder. Idempotent: an already-paid
 * order returns unchanged (and activation is re-run, which is itself idempotent).
 */
export async function markOrderPaid(
  orderId: ObjectId,
  payment: { razorpayPaymentId?: string; source: 'verify' | 'webhook' | 'credit' },
  ctx: OpCtx,
): Promise<Order> {
  const db = await getDb();
  const order = await col.orders(db).findOne({ _id: orderId });
  if (!order) throw new NotFoundError('Order not found');

  if (order.status !== 'paid' && order.status !== 'partially_refunded' && order.status !== 'refunded') {
    const from = order.status;
    assertTransition('order', ORDER_TRANSITIONS, from, 'paid');
    const res = await col.orders(db).updateOne(
      { _id: orderId, status: from },
      {
        $set: {
          status: 'paid',
          paidAt: ctx.now,
          ...(payment.razorpayPaymentId ? { razorpayPaymentId: payment.razorpayPaymentId } : {}),
        },
      },
    );
    if (res.matchedCount === 1) {
      await recordEvent(ctx, {
        entity: 'order',
        entityId: orderId.toHexString(),
        type: 'order.paid',
        from,
        to: 'paid',
        mobile: order.mobile,
        data: { source: payment.source, ...(payment.razorpayPaymentId ? { razorpayPaymentId: payment.razorpayPaymentId } : {}) },
      }, db);

      // A late payment on an EXPIRED order: its credit spend was reversed at expiry.
      // Re-debit it; if the balance no longer covers it, record the shortfall for ops
      // (money received always wins — the plan still activates).
      const applied = order.creditAppliedPaise ?? 0;
      if (from === 'expired' && applied > 0) {
        try {
          await spendCredit(order.mobile, applied, 'order_spend', { orderId, note: 'late payment re-debit' }, ctx);
        } catch (err) {
          await recordEvent(ctx, {
            entity: 'order',
            entityId: orderId.toHexString(),
            type: 'order.credit_shortfall',
            mobile: order.mobile,
            reason: err instanceof Error ? err.message : 'credit re-debit failed',
            data: { creditAppliedPaise: applied },
          }, db);
        }
      }
    } else {
      // A concurrent writer (verify vs webhook) won; it must have made it paid.
      const now = await col.orders(db).findOne({ _id: orderId });
      if (now?.status !== 'paid') throw new ConflictError('Order changed state while confirming payment');
    }
  }

  await activateOrder(orderId, ctx);

  const paid = await col.orders(db).findOne({ _id: orderId });
  if (!paid) throw new NotFoundError('Order not found');

  if ((paid.purpose ?? 'new') !== 'extra') {
    const sub = await col.subscriptions(db).findOne({ orderId });
    if (sub) {
      await enqueueMessage(
        {
          mobile: paid.mobile,
          template: 'order_confirmed',
          params: {
            name: paid.name ?? '',
            plan: planLabel(paid),
            startDate: humanDate(sub.startDate),
            endDate: humanDate(sub.endDate),
            amount: formatINR(paid.amountPaise),
          },
          dedupeKey: `order_confirmed:${orderId.toHexString()}`,
        },
        ctx,
      );
    }
  }
  return paid;
}

export async function markOrderFailed(orderId: ObjectId, ctx: OpCtx): Promise<void> {
  const db = await getDb();
  const order = await col.orders(db).findOne({ _id: orderId });
  if (!order) throw new NotFoundError('Order not found');
  if (order.status === 'failed') return;
  // A failure report for an order that is already paid/expired is stale: ignore.
  if (order.status !== 'created') return;
  assertTransition('order', ORDER_TRANSITIONS, 'created', 'failed');
  const res = await col.orders(db).updateOne(
    { _id: orderId, status: 'created' },
    { $set: { status: 'failed', failedAt: ctx.now } },
  );
  if (res.matchedCount === 1) {
    await recordEvent(ctx, {
      entity: 'order',
      entityId: orderId.toHexString(),
      type: 'order.failed',
      from: 'created',
      to: 'failed',
      mobile: order.mobile,
    }, db);
  }
  // The credit spend stays: a failed attempt can be retried on the same order.
  // expireUnpaidOrders reverses it if no payment ever arrives.
}

/** Dispatch by purpose: new/renewal → subscription activation; extra → lib/extras.activateExtraOrder. */
export async function activateOrder(orderId: ObjectId, ctx: OpCtx): Promise<void> {
  const db = await getDb();
  const order = await col.orders(db).findOne({ _id: orderId }, { projection: { purpose: 1, status: 1 } });
  if (!order) throw new NotFoundError('Order not found');
  if (order.purpose === 'extra') {
    await activateExtraOrder(orderId, ctx);
    return;
  }
  await activateSubscriptionForOrder(orderId, ctx);
}

/** Tick step: created|failed orders older than unpaidOrderExpiryMinutes → expired (credit spends reversed). */
export async function expireUnpaidOrders(ctx: OpCtx): Promise<{ expired: number }> {
  const db = await getDb();
  const settings = await getOpsSettings(db);
  const cutoff = new Date(ctx.now.getTime() - settings.unpaidOrderExpiryMinutes * 60_000);
  const stale = await col
    .orders(db)
    .find({ status: { $in: ['created', 'failed'] }, createdAt: { $lt: cutoff } })
    .limit(500)
    .toArray();
  let expired = 0;
  for (const o of stale) {
    if (!o._id) continue;
    const from = o.status;
    assertTransition('order', ORDER_TRANSITIONS, from, 'expired');
    const res = await col
      .orders(db)
      .updateOne({ _id: o._id, status: from }, { $set: { status: 'expired', expiredAt: ctx.now } });
    if (res.matchedCount !== 1) continue;
    expired++;
    if ((o.creditAppliedPaise ?? 0) > 0) await reverseOrderSpend(o._id, ctx);
    await recordEvent(ctx, {
      entity: 'order',
      entityId: o._id.toHexString(),
      type: 'order.expired',
      from,
      to: 'expired',
      mobile: o.mobile,
    }, db);
  }
  return { expired };
}
