'use client';

import { useCallback, useState } from 'react';

/**
 * Client helpers for the account dashboard: one way to call the JSON API and one
 * way to show what went wrong. Every mutation on /account goes through `useAction`
 * so pending / error / issues[] behave the same everywhere.
 */

export interface ApiFailure {
  status: number;
  error: string;
  issues: string[];
  code?: string;
  /** date_locked: the earliest date that can still change */
  firstOpen?: string;
  date?: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; fail: ApiFailure };

export async function callApi<T>(url: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? (init?.body === undefined ? 'GET' : 'POST'),
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      fail: { status: 0, error: 'Could not reach Maavuli. Check your connection and try again.', issues: [] },
    };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    /* non-JSON answer: handled below */
  }
  if (res.ok) return { ok: true, data: body as T };
  const issues = Array.isArray(body.issues) ? body.issues.filter((x): x is string => typeof x === 'string') : [];
  const fail: ApiFailure = {
    status: res.status,
    error:
      typeof body.error === 'string' && body.error
        ? body.error
        : res.status === 401
          ? 'Your session has ended. Please sign in again.'
          : 'Something went wrong. Please try again.',
    issues,
  };
  if (typeof body.code === 'string') fail.code = body.code;
  if (typeof body.firstOpen === 'string') fail.firstOpen = body.firstOpen;
  if (typeof body.date === 'string') fail.date = body.date;
  return { ok: false, fail };
}

/** pending + last failure around one async action. `run` resolves to the data or null. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [fail, setFail] = useState<ApiFailure | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<ApiResult<T>>): Promise<T | null> => {
    setPending(true);
    setFail(null);
    try {
      const r = await fn();
      if (r.ok) return r.data;
      setFail(r.fail);
      return null;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, fail, setFail, run };
}

export function ErrorNote({ fail }: { fail: ApiFailure | null }) {
  if (!fail) return null;
  return (
    <div className="acct-err" role="alert">
      <p>{fail.error}</p>
      {fail.issues.length > 0 && (
        <ul>
          {fail.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ formatting -- */

const dayFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/** "Thu 2 Oct" for a YYYY-MM-DD (read as an IST calendar date). */
export function dayLabel(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  return dayFmt.format(new Date(`${ymd}T12:00:00+05:30`)).replace(',', '');
}

/** A client-generated idempotency key (8–100 of [A-Za-z0-9_-]). */
export function newKey(prefix: string): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${rnd}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
}
