/**
 * Ops settings — the single `settings` document (_id 'ops'), editable in admin.
 *
 * Stored values are merged over DEFAULT_OPS so a partially-written or missing
 * document never produces an undefined cutoff. Changing a setting never re-opens a
 * date that is already materially locked (see lib/daylock) — it only moves the
 * cutoff for dates that have not locked yet.
 */

import type { Db } from 'mongodb';
import { getDb } from './db';
import { col, type OpsSettings } from './models';
import { DEFAULT_DAY_RULES, validateDayRules, type DayRules } from './cutoff';
import { ValidationError } from './errors';
import { recordEvent } from './events';
import { SYSTEM_ACTOR, type OpCtx } from './clock';

export type OpsSettingsValues = Omit<OpsSettings, '_id' | 'updatedAt' | 'updatedBy'>;

export const DEFAULT_OPS: OpsSettingsValues = {
  ...DEFAULT_DAY_RULES,
  photoRetentionDays: 60,
  renewalReminderDays: [7, 3, 1],
  unpaidOrderExpiryMinutes: 30,
  proofDistanceFlagM: 150,
};

export type OpsSettingsPatch = Partial<OpsSettingsValues>;

const EDITABLE = Object.keys(DEFAULT_OPS) as (keyof OpsSettingsValues)[];

export async function getOpsSettings(db?: Db): Promise<OpsSettings> {
  const d = db ?? (await getDb());
  const stored = await col.settings(d).findOne({ _id: 'ops' });
  return {
    _id: 'ops',
    ...DEFAULT_OPS,
    ...(stored ?? {}),
    updatedAt: stored?.updatedAt ?? new Date(0),
    updatedBy: stored?.updatedBy ?? SYSTEM_ACTOR,
  } as OpsSettings;
}

export function dayRulesOf(s: OpsSettingsValues): DayRules {
  return {
    cutoffTime: s.cutoffTime,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    dayCloseTime: s.dayCloseTime,
  };
}

/**
 * The live day rules for display on public pages (policies, FAQ). A database
 * outage must not take a policy page down, so it falls back to the defaults.
 */
export async function dayRulesForDisplay(): Promise<DayRules> {
  try {
    return dayRulesOf(await getOpsSettings());
  } catch {
    return DEFAULT_DAY_RULES;
  }
}

export function validateOpsSettings(s: OpsSettingsValues): string[] {
  const errs = validateDayRules(dayRulesOf(s));
  const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(s.photoRetentionDays, 7, 365)) errs.push('photoRetentionDays must be a whole number between 7 and 365');
  if (!int(s.unpaidOrderExpiryMinutes, 5, 1440)) errs.push('unpaidOrderExpiryMinutes must be between 5 and 1440');
  if (!int(s.proofDistanceFlagM, 20, 2000)) errs.push('proofDistanceFlagM must be between 20 and 2000');
  if (
    !Array.isArray(s.renewalReminderDays) ||
    s.renewalReminderDays.length > 5 ||
    !s.renewalReminderDays.every(d => int(d, 1, 30))
  ) {
    errs.push('renewalReminderDays must be up to 5 whole numbers between 1 and 30');
  }
  return errs;
}

/** Apply a patch (unknown keys rejected), validate the merged result, persist, log. */
export async function updateOpsSettings(patch: Record<string, unknown>, ctx: OpCtx): Promise<OpsSettings> {
  const unknown = Object.keys(patch).filter(k => !EDITABLE.includes(k as keyof OpsSettingsValues));
  if (unknown.length) throw new ValidationError('Unknown settings', unknown.map(k => `unknown setting "${k}"`));

  const db = await getDb();
  const current = await getOpsSettings(db);
  const { _id, updatedAt, updatedBy, ...currentValues } = current;
  void _id;
  void updatedAt;
  void updatedBy;
  const merged = { ...currentValues, ...(patch as OpsSettingsPatch) } as OpsSettingsValues;
  const errs = validateOpsSettings(merged);
  if (errs.length) throw new ValidationError('Invalid settings', errs);

  const changed = EDITABLE.filter(k => JSON.stringify(currentValues[k]) !== JSON.stringify(merged[k]));
  await col.settings(db).updateOne(
    { _id: 'ops' },
    { $set: { ...merged, updatedAt: ctx.now, updatedBy: ctx.actor } },
    { upsert: true },
  );
  if (changed.length) {
    await recordEvent(
      ctx,
      {
        entity: 'settings',
        entityId: 'ops',
        type: 'settings.updated',
        data: Object.fromEntries(changed.map(k => [k, { from: currentValues[k], to: merged[k] }])),
      },
      db,
    );
  }
  return getOpsSettings(db);
}
