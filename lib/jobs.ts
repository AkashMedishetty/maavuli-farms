/**
 * The 5-minute tick: every scheduled job, in a fixed order, each step isolated.
 *
 * Vercel Cron calls GET /api/cron/tick every 5 minutes (vercel.json). A step that
 * throws is recorded and the tick moves on — one broken step (say, the WhatsApp
 * provider is down) must never stop tomorrow from locking at the cutoff.
 *
 * LEASES: each step takes a lease in `job_runs` before running, so two overlapping
 * ticks (a slow run + the next schedule, or a manual trigger) never execute the same
 * step twice at once. Leases and min-intervals use REAL time, deliberately: business
 * time (`ctx.now`) can be moved by e2e tests, and a lease that expired in "test time"
 * would let two real processes collide.
 */

import { getDb } from './db';
import { col } from './models';
import type { OpCtx } from './clock';
import { activateDueSubscriptions, completeEndedSubscriptions } from './subscriptions';
import { expireUnpaidOrders } from './orders';
import { autoResolveStaleUnconfirmed, closeDueDays, lockDueDays } from './manifest';
import { compensatePendingMisses } from './compensation';
import { drainOutbox, enqueueRenewalReminders } from './notify';
import { refreshStaleRoutes } from './route-plan';
import { purgeOldPhotos } from './storage';

const MIN = 60_000;

export interface TickStep {
  name: string;
  /** lease length — longer than the step can plausibly take */
  leaseMs: number;
  /** skip when the last successful run was more recent than this (real time) */
  minIntervalMs?: number;
  run: (ctx: OpCtx) => Promise<object>;
}

/** Contract §5 order. */
export const TICK_STEPS: readonly TickStep[] = [
  { name: 'expireUnpaidOrders', leaseMs: 2 * MIN, run: expireUnpaidOrders },
  { name: 'activateDueSubscriptions', leaseMs: 2 * MIN, run: activateDueSubscriptions },
  { name: 'lockDueDays', leaseMs: 4 * MIN, run: lockDueDays },
  { name: 'closeDueDays', leaseMs: 4 * MIN, run: closeDueDays },
  { name: 'autoResolveStaleUnconfirmed', leaseMs: 4 * MIN, run: autoResolveStaleUnconfirmed },
  { name: 'compensatePendingMisses', leaseMs: 3 * MIN, run: compensatePendingMisses },
  { name: 'completeEndedSubscriptions', leaseMs: 2 * MIN, run: completeEndedSubscriptions },
  { name: 'enqueueRenewalReminders', leaseMs: 3 * MIN, minIntervalMs: 60 * MIN, run: enqueueRenewalReminders },
  { name: 'drainOutbox', leaseMs: 3 * MIN, run: drainOutbox },
  { name: 'refreshStaleRoutes', leaseMs: 4 * MIN, minIntervalMs: 60 * MIN, run: refreshStaleRoutes },
  { name: 'purgeOldPhotos', leaseMs: 4 * MIN, minIntervalMs: 12 * 60 * MIN, run: purgeOldPhotos },
];

export interface StepReport {
  step: string;
  ok: boolean;
  skipped?: 'leased' | 'not_due';
  ms: number;
  report?: object;
  error?: string;
}

/**
 * Take the lease for `step`. The filter only matches an expired/absent lease; when
 * another process holds it, the upsert collides on _id (E11000) — that is "busy".
 */
async function acquire(step: string, leaseMs: number): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  try {
    await col.jobRuns(db).updateOne(
      { _id: step, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }] },
      { $set: { leaseUntil: new Date(now.getTime() + leaseMs) } },
      { upsert: true },
    );
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

/** Run `fn` under the step's lease. Returns null when another process holds it. */
export async function withLease<T>(step: string, leaseMs: number, fn: () => Promise<T>): Promise<{ value: T } | null> {
  if (!(await acquire(step, leaseMs))) return null;
  try {
    return { value: await fn() };
  } finally {
    const db = await getDb();
    await col.jobRuns(db).updateOne({ _id: step }, { $unset: { leaseUntil: '' } });
  }
}

export interface TickOptions {
  /** ignore minIntervalMs (manual trigger, tests) */
  force?: boolean;
  /** run only these steps */
  only?: readonly string[];
}

export async function runTick(ctx: OpCtx, opts: TickOptions = {}): Promise<StepReport[]> {
  const db = await getDb();
  const reports: StepReport[] = [];
  for (const step of TICK_STEPS) {
    if (opts.only && !opts.only.includes(step.name)) continue;
    const started = Date.now();

    if (step.minIntervalMs && !opts.force) {
      const last = await col.jobRuns(db).findOne({ _id: step.name });
      if (last?.lastOk && last.lastRunAt && started - last.lastRunAt.getTime() < step.minIntervalMs) {
        reports.push({ step: step.name, ok: true, skipped: 'not_due', ms: 0 });
        continue;
      }
    }

    let outcome: StepReport;
    try {
      const res = await withLease(step.name, step.leaseMs, () => step.run(ctx));
      outcome = res
        ? { step: step.name, ok: true, ms: Date.now() - started, report: res.value }
        : { step: step.name, ok: true, skipped: 'leased', ms: Date.now() - started };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[tick] ${step.name} failed:`, message);
      outcome = { step: step.name, ok: false, ms: Date.now() - started, error: message.slice(0, 300) };
    }

    if (outcome.skipped !== 'leased') {
      await col.jobRuns(db).updateOne(
        { _id: step.name },
        {
          $set: {
            lastRunAt: new Date(),
            lastOk: outcome.ok,
            ...(outcome.report ? { lastReport: outcome.report as Record<string, unknown> } : {}),
          },
          ...(outcome.ok ? { $unset: { lastError: '' } } : { $set: { lastError: outcome.error ?? 'failed' } }),
        },
        { upsert: true },
      );
    }
    reports.push(outcome);
  }
  return reports;
}

/** For the admin "system health" card: the last run of every step. */
export async function jobStatus(): Promise<
  { step: string; lastRunAt: string | null; lastOk: boolean | null; lastError?: string; leased: boolean }[]
> {
  const db = await getDb();
  const rows = await col.jobRuns(db).find({}).toArray();
  const byName = new Map(rows.map(r => [r._id, r]));
  const now = Date.now();
  return TICK_STEPS.map(s => {
    const r = byName.get(s.name);
    return {
      step: s.name,
      lastRunAt: r?.lastRunAt ? r.lastRunAt.toISOString() : null,
      lastOk: r?.lastOk ?? null,
      ...(r?.lastError ? { lastError: r.lastError } : {}),
      leased: Boolean(r?.leaseUntil && r.leaseUntil.getTime() > now),
    };
  });
}
