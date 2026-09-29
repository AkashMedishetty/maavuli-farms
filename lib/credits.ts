/**
 * Credit ledger (immutable entries; balance = sum). OWNER: B3 (money).
 *
 * Every row is a signed paise amount; balance = their sum. Positive rows are credit
 * TO the customer (missed delivery, goodwill, a cancellation balance, a late extra);
 * negative rows are spends (checkout, an extra, a refund payout, a clawback). Rows are
 * never mutated or deleted — a correction is another row.
 *
 * `refundable` marks value that came from a PAID day we did not deliver. It is
 * returned at cancellation, so creditBalance reports how much of the live balance is
 * still refundable: refundable credit added, minus what was already paid out
 * (refund_payout) or clawed back (an 'adjustment' debit tied to a delivery), floored
 * at 0 and never above the balance itself.
 *
 * CONCURRENCY. Two spends racing must never both succeed against a balance that only
 * covers one. A version counter is not enough: a second spender can claim version
 * v+1 after the first claimed v but before the first's debit row is written, and
 * both then read the same (stale) balance. So every read-balance-then-debit runs
 * inside a per-mobile LEASE on the user document (`creditLockToken` /
 * `creditLockUntil`): acquire → read balance → write row → release. The lease
 * expires on its own (LEASE_MS) so a crashed holder cannot wedge the account. The
 * lease is a physical mutex, so it uses wall-clock time, never ctx.now (a test's
 * business "now" may be months away from the real clock).
 */

import { randomBytes } from 'node:crypto';
import type { Db, Filter, ObjectId, UpdateFilter } from 'mongodb';
import { getDb } from './db';
import { col, normalizeMobile, type CreditEntry, type StaffRole, type User } from './models';
import { recordEvent } from './events';
import { ConflictError, ValidationError } from './errors';
import type { OpCtx } from './clock';

export interface CreditBalance {
  balancePaise: number;
  /** portion of the balance that came from paid-but-missed days (returned at cancellation) */
  refundablePaise: number;
}

export type SpendKind = 'makeup_spend' | 'extra_spend' | 'order_spend' | 'refund_payout' | 'adjustment';

/**
 * Per-entry goodwill caps by staff role (PLATFORM-CONTRACT §4): support ₹200,
 * ops ₹1,000, owner ₹10,000. The ONE definition — the admin API enforces it and
 * the admin UI shows it.
 */
export const GOODWILL_CAP_PAISE: Readonly<Record<StaffRole, number>> = {
  support: 20_000,
  ops: 100_000,
  owner: 1_000_000,
};

const LEASE_MS = 15_000;
const WAIT_STEP_MS = 40;
const MAX_WAIT_MS = 10_000;

function normOrThrow(mobile: string): string {
  const m = normalizeMobile(mobile);
  if (!m) throw new ValidationError(`Invalid mobile: "${mobile}"`);
  return m;
}

/** Pure fold over ledger rows — exported for tests. */
export function foldBalance(rows: readonly Pick<CreditEntry, 'amountPaise' | 'kind' | 'refundable' | 'deliveryId'>[]): CreditBalance {
  let balancePaise = 0;
  let refundableIn = 0;
  let refundableOut = 0;
  for (const r of rows) {
    balancePaise += r.amountPaise;
    if (r.amountPaise > 0 && r.refundable) refundableIn += r.amountPaise;
    if (r.amountPaise < 0 && (r.kind === 'refund_payout' || (r.kind === 'adjustment' && r.deliveryId))) {
      refundableOut += -r.amountPaise;
    }
  }
  const refundablePaise = Math.max(0, Math.min(refundableIn - refundableOut, balancePaise));
  return { balancePaise, refundablePaise };
}

async function balanceIn(db: Db, mobile: string): Promise<CreditBalance> {
  const rows = await col
    .credits(db)
    .find({ mobile }, { projection: { amountPaise: 1, kind: 1, refundable: 1, deliveryId: 1 } })
    .toArray();
  return foldBalance(rows);
}

export async function creditBalance(mobile: string): Promise<CreditBalance> {
  const m = normOrThrow(mobile);
  return balanceIn(await getDb(), m);
}

export async function creditHistory(mobile: string, limit = 100): Promise<CreditEntry[]> {
  const m = normOrThrow(mobile);
  const db = await getDb();
  const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
  return col.credits(db).find({ mobile: m }).sort({ at: -1, _id: -1 }).limit(n).toArray();
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Run `fn` holding the per-mobile credit lease. The user row must exist (accounts are
 * provisioned from the first paid order; nobody can hold credit without one).
 * Exported so refunds/compensation can make a read-then-write on the ledger atomic.
 */
export async function withCreditLock<T>(mobile: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const m = normOrThrow(mobile);
  const db = await getDb();
  const users = col.users(db);
  const token = randomBytes(12).toString('hex');
  const started = Date.now();
  for (;;) {
    const wall = new Date();
    // creditLockToken / creditLockUntil are not on the User type (models.ts is
    // frozen) — see the Request in the B3 report. The driver accepts extra keys.
    const filter = {
      mobile: m,
      $or: [{ creditLockUntil: { $exists: false } }, { creditLockUntil: { $lt: wall } }],
    } as Filter<User>;
    const update = {
      $set: { creditLockToken: token, creditLockUntil: new Date(wall.getTime() + LEASE_MS) },
    } as UpdateFilter<User>;
    const got = await users.updateOne(filter, update);
    if (got.matchedCount === 1) break;
    if ((await users.countDocuments({ mobile: m }, { limit: 1 })) === 0) {
      throw new ConflictError('There is no account for this mobile yet.', { mobile: m });
    }
    if (Date.now() - started > MAX_WAIT_MS) {
      throw new ConflictError('Your credit balance is busy — please try again.', { mobile: m });
    }
    await sleep(WAIT_STEP_MS + Math.floor(Math.random() * WAIT_STEP_MS));
  }
  try {
    return await fn(db);
  } finally {
    await users.updateOne(
      { mobile: m, creditLockToken: token } as Filter<User>,
      { $unset: { creditLockToken: '', creditLockUntil: '' } } as UpdateFilter<User>,
    );
  }
}

async function insertEntry(db: Db, doc: CreditEntry, ctx: OpCtx): Promise<CreditEntry & { _id: ObjectId }> {
  const res = await col.credits(db).insertOne(doc);
  await recordEvent(
    ctx,
    {
      entity: 'credit',
      entityId: res.insertedId.toHexString(),
      type: `credit.${doc.kind}`,
      mobile: doc.mobile,
      data: {
        amountPaise: doc.amountPaise,
        refundable: doc.refundable,
        ...(doc.orderId ? { orderId: doc.orderId.toHexString() } : {}),
        ...(doc.deliveryId ? { deliveryId: doc.deliveryId.toHexString() } : {}),
        ...(doc.refundId ? { refundId: doc.refundId.toHexString() } : {}),
      },
    },
    db,
  );
  return { ...doc, _id: res.insertedId };
}

/** Positive entry. Writes a DomainEvent. Adding can never overdraw, so no lease. */
export async function addCredit(
  entry: Omit<CreditEntry, '_id' | 'at' | 'actor'> & { amountPaise: number },
  ctx: OpCtx,
): Promise<CreditEntry> {
  if (!Number.isInteger(entry.amountPaise) || entry.amountPaise <= 0) {
    throw new ValidationError('addCredit: amountPaise must be a positive integer (paise)');
  }
  const m = normOrThrow(entry.mobile);
  const db = await getDb();
  return insertEntry(db, { ...entry, mobile: m, actor: ctx.actor, at: ctx.now }, ctx);
}

/** Inside a held lease: debit or throw ConflictError. */
export async function spendLocked(
  db: Db,
  mobile: string,
  amountPaise: number,
  kind: SpendKind,
  refs: { orderId?: ObjectId; subscriptionId?: ObjectId; deliveryId?: ObjectId; refundId?: ObjectId; note?: string },
  ctx: OpCtx,
): Promise<CreditEntry & { _id: ObjectId }> {
  const { balancePaise } = await balanceIn(db, mobile);
  if (balancePaise < amountPaise) {
    throw new ConflictError('Not enough credit for this.', { balancePaise, requiredPaise: amountPaise });
  }
  return insertEntry(
    db,
    {
      mobile,
      amountPaise: -amountPaise,
      kind,
      refundable: false,
      ...(refs.orderId ? { orderId: refs.orderId } : {}),
      ...(refs.subscriptionId ? { subscriptionId: refs.subscriptionId } : {}),
      ...(refs.deliveryId ? { deliveryId: refs.deliveryId } : {}),
      ...(refs.refundId ? { refundId: refs.refundId } : {}),
      ...(refs.note ? { note: refs.note } : {}),
      actor: ctx.actor,
      at: ctx.now,
    },
    ctx,
  );
}

/** Negative entry of `amountPaise` (> 0). Throws ConflictError when the balance is insufficient. */
export async function spendCredit(
  mobile: string,
  amountPaise: number,
  kind: SpendKind,
  refs: { orderId?: ObjectId; subscriptionId?: ObjectId; deliveryId?: ObjectId; refundId?: ObjectId; note?: string },
  ctx: OpCtx,
): Promise<CreditEntry> {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new ValidationError('spendCredit: amountPaise must be a positive integer (paise)');
  }
  const m = normOrThrow(mobile);
  return withCreditLock(m, db => spendLocked(db, m, amountPaise, kind, refs, ctx));
}

/**
 * Undo an order's credit spend (order expired / failed permanently). Idempotent per
 * order: the net of the order's spend and reversal rows is computed under the lease,
 * so two concurrent reversals cannot both add the money back.
 */
export async function reverseOrderSpend(orderId: ObjectId, ctx: OpCtx): Promise<void> {
  const db = await getDb();
  const first = await col.credits(db).findOne({ orderId, kind: { $in: ['order_spend', 'extra_spend'] } });
  if (!first) return; // nothing was spent on this order
  await withCreditLock(first.mobile, async d => {
    const rows = await col
      .credits(d)
      .find({ orderId, kind: { $in: ['order_spend', 'extra_spend', 'order_spend_reversal'] } })
      .toArray();
    const net = rows.reduce((s, r) => s + r.amountPaise, 0);
    if (net >= 0) return; // already reversed
    await insertEntry(
      d,
      {
        mobile: first.mobile,
        amountPaise: -net,
        kind: 'order_spend_reversal',
        refundable: false,
        orderId,
        note: 'Order not paid — credit returned',
        actor: ctx.actor,
        at: ctx.now,
      },
      ctx,
    );
  });
}
