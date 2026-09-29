/**
 * The notification provider seam. OWNER: B6.
 *
 * A provider turns one queued message into an actual (or logged) send. Exactly two
 * exist: 'log' (records the message, sends nothing) and 'meta' (WhatsApp Cloud API).
 * Which one is used is decided by WHATSAPP_PROVIDER (see resolveProvider).
 */

import type { Lang } from '../../models';
import type { RenderableTemplate } from '../templates';

export interface SendRequest {
  /** 10-digit normalised mobile (E.164 is built inside the provider). */
  mobile: string;
  template: RenderableTemplate;
  lang: Lang;
  params: Record<string, string>;
  /** optional image header URL (e.g. the doorstep photo) */
  mediaUrl?: string;
}

export type SendResult =
  /** the message left the building (or was recorded by the log driver) */
  | { ok: true; providerMessageId: string; status: 'sent' | 'logged' }
  /** a permanent failure — do not retry (bad number, template rejected) */
  | { ok: false; retryable: false; error: string }
  /** a transient failure — retry per the backoff schedule */
  | { ok: false; retryable: true; error: string };

export interface NotifyProvider {
  readonly name: string;
  send(req: SendRequest): Promise<SendResult>;
}
