/**
 * Pure formatting + labels for the ops console. No imports of runtime modules, so
 * both server pages and client components can use it.
 */

const IST = 'Asia/Kolkata';

/** "Thu 2 Oct" for a YYYY-MM-DD (noon IST, so the calendar day never shifts). */
export function ymdLabel(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return ymd;
  return new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

/** "4:00 pm" for an ISO instant, in IST. */
export function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit' }).format(d);
}

/** "Wed 1 Oct, 4:00 pm" for an ISO instant, in IST. */
export function dateTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

/** "12 min ago" / "3 h ago" relative to `now` (both ISO or Date). */
export function agoLabel(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  if (ms < 60_000) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "1.5 L" / "2 L". */
export function litres(n: number): string {
  const r = Math.round(n * 100) / 100;
  return `${String(r)} L`;
}

/** "820 m" / "3.4 km". */
export function distance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export function milkLabel(kind: string): string {
  return kind === 'cow' ? 'Cow' : kind === 'buffalo' ? 'Buffalo' : kind;
}

export const STATUS_LABEL: Record<string, string> = {
  planned: 'Planned',
  locked: 'Locked',
  out_for_delivery: 'Out',
  delivered: 'Delivered',
  not_delivered: 'Not delivered',
  unconfirmed: 'Unconfirmed',
  cancelled: 'Cancelled',
  scheduled: 'Scheduled (legacy)',
  skipped: 'Skipped (legacy)',
  failed: 'Failed (legacy)',
  // run statuses
  preview: 'Preview',
  in_progress: 'In progress',
  completed: 'Completed',
  closed: 'Closed',
};

export function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

/** Rider-facing reasons, grouped the way ops think about them. Mirrors models.REASON_FAULT. */
export const REASONS: readonly { id: string; label: string; fault: 'ours' | 'customer' | 'unknown' }[] = [
  { id: 'no_access', label: 'No access', fault: 'customer' },
  { id: 'refused', label: 'Refused', fault: 'customer' },
  { id: 'customer_asked_skip', label: 'Asked to skip', fault: 'customer' },
  { id: 'out_of_stock', label: 'Out of stock', fault: 'ours' },
  { id: 'vehicle_issue', label: 'Vehicle issue', fault: 'ours' },
  { id: 'rider_absent', label: 'Rider absent', fault: 'ours' },
  { id: 'spoiled', label: 'Spoiled', fault: 'ours' },
  { id: 'could_not_find', label: 'Could not find', fault: 'unknown' },
  { id: 'other', label: 'Other', fault: 'unknown' },
];

export function reasonLabel(id: string | undefined): string {
  if (!id) return '—';
  if (id === 'disruption') return 'Disruption';
  return REASONS.find(r => r.id === id)?.label ?? id;
}

export const DONE_ITEM_STATUSES: readonly string[] = ['delivered', 'not_delivered', 'cancelled'];

/** Read `{ error, issues }` from a failed API response. */
export async function apiError(res: Response, fallback: string): Promise<{ error: string; issues: string[] }> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; issues?: unknown } | null;
  const error = body && typeof body.error === 'string' ? body.error : `${fallback} (HTTP ${res.status})`;
  const issues = body && Array.isArray(body.issues) ? body.issues.filter((i): i is string => typeof i === 'string') : [];
  return { error, issues };
}
