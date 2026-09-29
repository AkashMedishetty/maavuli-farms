/**
 * The 'log' provider: renders the message and records it, sends NOTHING. OWNER: B6.
 *
 * This is the default outside production (WHATSAPP_PROVIDER unset). It exists so the
 * whole notification pipeline — enqueue, dedupe, opt-in, drain, status accounting —
 * is exercised end to end in development and tests without a WhatsApp account and
 * without any risk of a real message reaching a real customer.
 *
 * It returns status 'logged' (never 'sent'), and a synthetic providerMessageId so
 * the outbox row still carries one. There is no code path where credentials being
 * present silently upgrades this to a real send: only WHATSAPP_PROVIDER=meta selects
 * the meta provider.
 */

import { render } from '../templates';
import type { NotifyProvider, SendRequest, SendResult } from './types';

let counter = 0;

function maskMobile(m: string): string {
  return m.length > 4 ? `${'•'.repeat(m.length - 4)}${m.slice(-4)}` : '••••';
}

export const logProvider: NotifyProvider = {
  name: 'log',
  async send(req: SendRequest): Promise<SendResult> {
    let preview: string;
    try {
      preview = render(req.template, req.lang, req.params);
    } catch (err) {
      // A missing param is a programming error in the enqueuer, not a transient
      // fault — surface it as permanent so it does not retry forever.
      return { ok: false, retryable: false, error: err instanceof Error ? err.message : String(err) };
    }
    const id = `log_${Date.now()}_${counter++}`;
    if (process.env.NODE_ENV === 'production') {
      // resolveProvider refuses 'log' in production; should it ever run there anyway,
      // never print the message body (codes, names, addresses) or a signed media URL.
      // eslint-disable-next-line no-console
      console.log(
        `[notify:log] → ${maskMobile(req.mobile)} [${req.template}/${req.lang}] (${preview.length} chars${req.mediaUrl ? ', with media' : ''})`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(`[notify:log] → ${req.mobile} [${req.template}/${req.lang}] ${preview}${req.mediaUrl ? ` (media: ${req.mediaUrl})` : ''}`);
    }
    return { ok: true, providerMessageId: id, status: 'logged' };
  },
};
