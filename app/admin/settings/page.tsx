import { loadErrorMessage, pageStaff } from '@/lib/admin';
import { getOpsSettings } from '@/lib/settings';
import { hmLabel } from '@/lib/cutoff';
import type { OpsSettings } from '@/lib/models';
import { LoadError } from '@/components/admin/ops/server';
import SettingsForm, { type SettingsValues } from '@/components/admin/ops/SettingsForm';
import { dateTimeLabel } from '@/components/admin/ops/format';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  const p = await pageStaff();
  if (!p) return null;

  let s: OpsSettings | null = null;
  let error: string | null = null;
  try {
    s = await getOpsSettings();
  } catch (err) {
    error = loadErrorMessage(err);
  }

  const values: SettingsValues | null = s
    ? {
        cutoffTime: s.cutoffTime,
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        dayCloseTime: s.dayCloseTime,
        photoRetentionDays: s.photoRetentionDays,
        renewalReminderDays: [...s.renewalReminderDays],
        unpaidOrderExpiryMinutes: s.unpaidOrderExpiryMinutes,
        proofDistanceFlagM: s.proofDistanceFlagM,
      }
    : null;
  const never = !s || s.updatedAt.getTime() === 0;

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Settings</p>
        <h1>Ops settings</h1>
        {s && (
          <p className="ops-sub">
            {never ? 'Using the defaults (never edited).' : `Last changed ${dateTimeLabel(s.updatedAt.toISOString())} by ${s.updatedBy.id}.`}{' '}
            A day that has already locked keeps its lock even if you move the cutoff.
          </p>
        )}
      </header>

      {error || !values ? (
        <LoadError what="settings" message={error ?? 'Unknown error.'} />
      ) : p.staffRole === 'owner' ? (
        <SettingsForm initial={values} />
      ) : (
        <section className="ops-card" aria-label="Current settings">
          <p className="ops-muted">Only the owner can change these.</p>
          <dl className="ops-kv">
            <dt>Cutoff (day before)</dt>
            <dd>{hmLabel(values.cutoffTime)}</dd>
            <dt>Delivery window</dt>
            <dd>
              {hmLabel(values.windowStart)} – {hmLabel(values.windowEnd)}
            </dd>
            <dt>Day closes</dt>
            <dd>{hmLabel(values.dayCloseTime)}</dd>
            <dt>Photo retention</dt>
            <dd>{values.photoRetentionDays} days</dd>
            <dt>Renewal reminders</dt>
            <dd>{values.renewalReminderDays.length ? `${values.renewalReminderDays.join(', ')} days before the end` : 'none'}</dd>
            <dt>Unpaid order expiry</dt>
            <dd>{values.unpaidOrderExpiryMinutes} min</dd>
            <dt>Proof distance flag</dt>
            <dd>{values.proofDistanceFlagM} m</dd>
          </dl>
        </section>
      )}
    </>
  );
}
