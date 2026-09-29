/**
 * Provider selection. OWNER: B6.
 *
 * WHATSAPP_PROVIDER decides which provider drainOutbox / sendAuthCode use:
 *   'log'   → the log driver (records, sends nothing) — refused in production
 *   'meta'  → the WhatsApp Cloud API
 *   unset   → 'log' OUTSIDE production; in production this is a configuration gap:
 *             resolveProvider throws ServiceNotConfiguredError and the message stays
 *             queued (never silently dropped, never silently sent).
 */

import { ServiceNotConfiguredError } from '../../errors';
import { logProvider } from './log';
import { metaProvider } from './meta';
import type { NotifyProvider } from './types';

export type { NotifyProvider, SendRequest, SendResult } from './types';
export { logProvider } from './log';
export { metaProvider } from './meta';

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Resolve the active provider. Throws ServiceNotConfiguredError in production with
 * WHATSAPP_PROVIDER unset or set to 'log', and for an unknown value anywhere.
 */
export function resolveProvider(): NotifyProvider {
  const raw = (process.env.WHATSAPP_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'meta') return metaProvider;
  if (raw === 'log') {
    // The log driver sends nothing: in production every customer message would be
    // silently swallowed (and was printed to the server log). Fail closed, like an
    // unset provider, so messages stay queued until a real channel is configured.
    if (isProd()) {
      throw new ServiceNotConfiguredError('WhatsApp', ['WHATSAPP_PROVIDER (the "log" driver is not allowed in production; use meta)']);
    }
    return logProvider;
  }
  if (raw === '') {
    if (isProd()) {
      throw new ServiceNotConfiguredError('WhatsApp', ['WHATSAPP_PROVIDER']);
    }
    return logProvider;
  }
  // an unknown value is a misconfiguration; fail loud rather than sending
  throw new ServiceNotConfiguredError('WhatsApp', [`WHATSAPP_PROVIDER (got "${raw}", expected log|meta)`]);
}
