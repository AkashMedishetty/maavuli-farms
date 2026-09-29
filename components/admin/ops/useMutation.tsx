'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { apiError } from './format';

export interface MutationState {
  pending: boolean;
  error: string | null;
  issues: string[];
  /** The API's machine-readable error code (e.g. 'upi_required'), when it sent one. */
  code: string | null;
  done: string | null;
}

/**
 * One same-origin JSON mutation with the §9 contract: disable while pending, show
 * the API's error (+ issues) next to the control, refresh the server data on success.
 */
export function useMutation() {
  const router = useRouter();
  const [state, setState] = useState<MutationState>({ pending: false, error: null, issues: [], code: null, done: null });

  const run = useCallback(
    async (
      url: string,
      init: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown },
      opts: { fallback: string; success?: string; refresh?: boolean } = { fallback: 'Request failed' },
    ): Promise<Record<string, unknown> | null> => {
      setState({ pending: true, error: null, issues: [], code: null, done: null });
      try {
        const res = await fetch(url, {
          method: init.method,
          headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          credentials: 'same-origin',
        });
        if (!res.ok) {
          const e = await apiError(res, opts.fallback);
          setState({ pending: false, error: e.error, issues: e.issues, code: e.code, done: null });
          return null;
        }
        const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
        setState({ pending: false, error: null, issues: [], code: null, done: opts.success ?? 'Done.' });
        if (opts.refresh !== false) router.refresh();
        return body;
      } catch {
        setState({
          pending: false,
          error: `${opts.fallback}: the network request did not complete. Check the connection and try again.`,
          issues: [],
          code: null,
          done: null,
        });
        return null;
      }
    },
    [router],
  );

  const reset = useCallback(() => setState({ pending: false, error: null, issues: [], code: null, done: null }), []);
  return { ...state, run, reset };
}

export function MutationMessage({ error, issues, done }: Pick<MutationState, 'error' | 'issues' | 'done'>) {
  if (error) {
    return (
      <div className="ops-error" role="alert">
        {error}
        {issues.length > 0 && (
          <ul>
            {issues.map(i => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (done) {
    return (
      <p className="ops-ok" role="status">
        {done}
      </p>
    );
  }
  return null;
}
