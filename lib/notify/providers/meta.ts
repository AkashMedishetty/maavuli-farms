/**
 * The 'meta' provider: WhatsApp Cloud API template send. OWNER: B6.
 *
 * Sends an approved TEMPLATE (never free-form text — business-initiated messages
 * outside the 24-hour service window must be templates), with positional body
 * components mapped from our ordered params, and an optional image header.
 *
 * Config (read at send time, never at import — see lib/env rules):
 *   WHATSAPP_TOKEN            Bearer token (system-user or temporary)
 *   WHATSAPP_PHONE_NUMBER_ID  the sending phone number id
 *   WHATSAPP_API_BASE         optional: overrides the base for Cloud-API-compatible
 *                             providers; defaults to the Meta Graph endpoint below
 *   WHATSAPP_AUTH_TEMPLATE    optional: Meta name of the authentication template
 *
 * On a missing config the provider throws ServiceNotConfiguredError naming the vars,
 * so a production drain leaves the message queued rather than dropping it.
 */

import { ServiceNotConfiguredError, UpstreamError } from '../../errors';
import { orderedParams, TEMPLATES, AUTH_TEMPLATE } from '../templates';
import type { NotifyProvider, SendRequest, SendResult } from './types';

/**
 * Current stable Meta Graph API version. Overridable via WHATSAPP_API_BASE so a
 * version bump — or a Cloud-API-compatible provider on another host — needs no code
 * change. Kept as a constant (not hardcoded at the call site) so there is one place
 * to bump it.
 */
export const DEFAULT_GRAPH_VERSION = 'v21.0';
export const DEFAULT_GRAPH_BASE = `https://graph.facebook.com/${DEFAULT_GRAPH_VERSION}`;

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** 10-digit Indian mobile → E.164 (91XXXXXXXXXX) for the WhatsApp `to` field. */
function toE164(mobile: string): string {
  const d = mobile.replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d;
}

interface MetaConfig {
  token: string;
  phoneNumberId: string;
  base: string;
  authTemplateName: string;
}

/** Read + validate config. Throws ServiceNotConfiguredError naming the missing vars. */
export function metaConfig(): MetaConfig {
  const token = read('WHATSAPP_TOKEN');
  const phoneNumberId = read('WHATSAPP_PHONE_NUMBER_ID');
  const missing: string[] = [];
  if (!token) missing.push('WHATSAPP_TOKEN');
  if (!phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (missing.length) throw new ServiceNotConfiguredError('WhatsApp', missing);
  return {
    token: token as string,
    phoneNumberId: phoneNumberId as string,
    base: (read('WHATSAPP_API_BASE') ?? DEFAULT_GRAPH_BASE).replace(/\/+$/, ''),
    authTemplateName: read('WHATSAPP_AUTH_TEMPLATE') ?? TEMPLATES[AUTH_TEMPLATE].metaName,
  };
}

/**
 * Build the Cloud API template payload. Body params are one text component per
 * ordered param. The authentication template also needs the code echoed in a URL
 * button component (Meta's copy-code button), which for our single-param auth
 * template is the same code value.
 */
function buildComponents(req: SendRequest): unknown[] {
  const values = orderedParams(req.template, req.params);
  const components: unknown[] = [];

  if (req.mediaUrl && req.template !== AUTH_TEMPLATE) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: req.mediaUrl } }],
    });
  }

  if (values.length) {
    components.push({
      type: 'body',
      parameters: values.map(text => ({ type: 'text', text })),
    });
  }

  if (req.template === AUTH_TEMPLATE) {
    // Authentication templates carry a copy-code button; its parameter is the code.
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: values[0] ?? '' }],
    });
  }

  return components;
}

/** HTTP status codes we treat as transient (retry) vs permanent (drop). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export const metaProvider: NotifyProvider = {
  name: 'meta',
  async send(req: SendRequest): Promise<SendResult> {
    const cfg = metaConfig();
    const metaName = req.template === AUTH_TEMPLATE ? cfg.authTemplateName : TEMPLATES[req.template].metaName;

    const payload = {
      messaging_product: 'whatsapp',
      to: toE164(req.mobile),
      type: 'template',
      template: {
        name: metaName,
        language: { code: req.lang },
        components: buildComponents(req),
      },
    };

    let res: Response;
    try {
      res = await fetch(`${cfg.base}/${cfg.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cfg.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // network failure — transient
      return { ok: false, retryable: true, error: err instanceof Error ? err.message : 'network error' };
    }

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* body may be empty on some errors */
    }

    if (res.ok) {
      const id = extractMessageId(json);
      if (!id) {
        // 200 but no id — treat as transient so we do not lose the message silently
        return { ok: false, retryable: true, error: 'no message id in response' };
      }
      return { ok: true, providerMessageId: id, status: 'sent' };
    }

    const errMsg = extractError(json) ?? `HTTP ${res.status}`;
    if (isRetryableStatus(res.status)) {
      return { ok: false, retryable: true, error: errMsg };
    }
    return { ok: false, retryable: false, error: errMsg };
  },
};

/** Pull the accepted message id from `{ messages: [{ id }] }`. */
function extractMessageId(json: unknown): string | null {
  if (json && typeof json === 'object' && 'messages' in json) {
    const messages = (json as { messages?: unknown }).messages;
    if (Array.isArray(messages) && messages.length) {
      const first = messages[0];
      if (first && typeof first === 'object' && 'id' in first) {
        const id = (first as { id?: unknown }).id;
        if (typeof id === 'string') return id;
      }
    }
  }
  return null;
}

/** Pull `error.message` from a Graph error body, for the outbox error column. */
function extractError(json: unknown): string | null {
  if (json && typeof json === 'object' && 'error' in json) {
    const error = (json as { error?: unknown }).error;
    if (error && typeof error === 'object' && 'message' in error) {
      const m = (error as { message?: unknown }).message;
      if (typeof m === 'string') return m;
    }
  }
  return null;
}

// re-export so index.ts can surface a typed upstream failure if it wants one
export { UpstreamError };
