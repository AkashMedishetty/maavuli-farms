/**
 * The 'aisensy' provider: WhatsApp through AiSensy's Campaign API. OWNER: B6.
 *
 * AiSensy is a Meta business-solution provider. It does NOT expose the Cloud API's
 * template endpoint to Basic/Pro customers; instead each approved template is wired
 * to an "API campaign" in the AiSensy dashboard, and we trigger that campaign per
 * recipient:
 *
 *   POST https://backend.aisensy.com/campaign/t1/api/v2
 *   { apiKey, campaignName, destination, userName, templateParams[], source,
 *     media?: { url, filename }, buttons?: [...] }
 *
 * So the unit of configuration is the CAMPAIGN NAME, one per template per language.
 * By convention it is `<prefix><metaName>_<lang>` — e.g. `order_confirmed_en` — and
 * any name can be overridden with AISENSY_CAMPAIGNS. `pnpm aisensy:campaigns` prints
 * the exact list to create, with the template copy and its {{1}}, {{2}}… order.
 *
 * Config (read at send time, never at import):
 *   AISENSY_API_KEY          required — dashboard → Manage → API Key
 *   AISENSY_LANGUAGES        languages that have live campaigns, comma-separated.
 *                            Default "en": a Telugu-preferring customer gets the
 *                            English campaign until the Telugu ones are approved
 *   AISENSY_CAMPAIGNS        optional JSON overrides: {"<template>[:<lang>]": "<campaign>"}
 *   AISENSY_CAMPAIGN_PREFIX  optional prefix for the conventional names
 *   AISENSY_API_URL          optional — overrides the endpoint above
 *
 * Two documented gaps in AiSensy's API, and how they are handled:
 *  · The response body is not documented and may carry no message id. We keep any id
 *    it does return, otherwise mint a synthetic one, and ALWAYS record the campaign
 *    name (providerRef) so a delivery receipt can be matched by mobile + campaign.
 *  · The OTP template's copy-code button value is shown only in a dashboard
 *    screenshot. We send it in the Cloud API's shape (sub_type url, index 0, the code
 *    as the one text parameter), which is what AiSensy relays to Meta. Confirmed on the
 *    first live test; if AiSensy wants another shape, buildAisensyPayload is the one
 *    place to change.
 */

import { ServiceNotConfiguredError } from '../../errors';
import type { Lang } from '../../models';
import { AUTH_TEMPLATE, orderedParams, render, TEMPLATES, type RenderableTemplate } from '../templates';
import type { NotifyProvider, SendRequest, SendResult } from './types';

export const DEFAULT_AISENSY_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';
const SERVICE = 'WhatsApp (AiSensy)';
const TIMEOUT_MS = 15_000;
const FALLBACK_NAME = 'Maavuli customer';

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export interface AisensyConfig {
  apiKey: string;
  url: string;
  /** languages with live campaigns; anything else is sent in English */
  languages: Lang[];
  /** "<template>" or "<template>:<lang>" → campaign name */
  overrides: Record<string, string>;
  prefix: string;
}

const LANGS: readonly Lang[] = ['en', 'te'];

/** Read + validate config. Throws ServiceNotConfiguredError naming what is wrong. */
export function aisensyConfig(): AisensyConfig {
  const apiKey = read('AISENSY_API_KEY');
  if (!apiKey) throw new ServiceNotConfiguredError(SERVICE, ['AISENSY_API_KEY']);

  const languages = (read('AISENSY_LANGUAGES') ?? 'en')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter((l): l is Lang => (LANGS as readonly string[]).includes(l));
  // English is the fallback for every other language, so it is always live.
  if (!languages.includes('en')) languages.unshift('en');

  let overrides: Record<string, string> = {};
  const raw = read('AISENSY_CAMPAIGNS');
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ServiceNotConfiguredError(SERVICE, ['AISENSY_CAMPAIGNS (not valid JSON)']);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ServiceNotConfiguredError(SERVICE, ['AISENSY_CAMPAIGNS (must be a JSON object of names)']);
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) overrides[k] = v.trim();
    }
  }

  return {
    apiKey,
    url: (read('AISENSY_API_URL') ?? DEFAULT_AISENSY_URL).replace(/\/+$/, ''),
    languages,
    overrides,
    prefix: read('AISENSY_CAMPAIGN_PREFIX') ?? '',
  };
}

/** The language actually sent: the customer's, if it has live campaigns, else English. */
export function sendLang(lang: Lang, cfg: Pick<AisensyConfig, 'languages'>): Lang {
  return cfg.languages.includes(lang) ? lang : 'en';
}

/**
 * The AiSensy campaign for a template in a language: an explicit override for that
 * template + language, else one for the template in any language, else the
 * conventional `<prefix><metaName>_<lang>`.
 *
 * A message sent WITH an image (the daily doorstep photo) uses a separate "_photo"
 * campaign: a WhatsApp template either has an image header or it does not, and the
 * photo is not always there (no photo taken, or no site URL to sign it with), so the
 * text-only and with-photo versions are two templates, two campaigns.
 */
export function campaignNameFor(
  template: RenderableTemplate,
  lang: Lang,
  cfg: Pick<AisensyConfig, 'languages' | 'overrides' | 'prefix'>,
  opts: { withImage?: boolean } = {},
): string {
  const l = sendLang(lang, cfg);
  const key = opts.withImage ? `${template}_photo` : template;
  const base = opts.withImage ? `${TEMPLATES[template].metaName}_photo` : TEMPLATES[template].metaName;
  return cfg.overrides[`${key}:${l}`] ?? cfg.overrides[key] ?? `${cfg.prefix}${base}_${l}`;
}

/** 10-digit Indian mobile → "+91XXXXXXXXXX" (AiSensy wants the country dial code). */
export function toDestination(mobile: string): string {
  const d = mobile.replace(/\D/g, '');
  return d.length === 10 ? `+91${d}` : `+${d}`;
}

/** AiSensy creates a contact under this name; never empty, never a page of text. */
function cleanName(name: string | undefined): string {
  const n = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return n || FALLBACK_NAME;
}

export interface AisensyPayload {
  apiKey: string;
  campaignName: string;
  destination: string;
  userName: string;
  templateParams: string[];
  source: string;
  media?: { url: string; filename: string };
  buttons?: { type: 'button'; sub_type: 'url'; index: number; parameters: { type: 'text'; text: string }[] }[];
}

/** Build the Campaign API body for one message. Pure. */
export function buildAisensyPayload(req: SendRequest, cfg: AisensyConfig): AisensyPayload {
  const templateParams = orderedParams(req.template, req.params);
  const withImage = !!req.mediaUrl && req.template !== AUTH_TEMPLATE;
  const payload: AisensyPayload = {
    apiKey: cfg.apiKey,
    campaignName: campaignNameFor(req.template, req.lang, cfg, { withImage }),
    destination: toDestination(req.mobile),
    userName: cleanName(req.userName),
    templateParams,
    source: 'Maavuli platform',
  };
  if (withImage && req.mediaUrl) {
    payload.media = { url: req.mediaUrl, filename: 'maavuli-delivery.jpg' };
  }
  if (req.template === AUTH_TEMPLATE) {
    // Authentication templates carry a copy-code button whose parameter is the code.
    payload.buttons = [{ type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: templateParams[0] ?? '' }] }];
  }
  return payload;
}

/* ------------------------------------------------------------- response -- */

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Any message id the (undocumented) response carries, top level or under `data`. */
function extractId(body: unknown): string | null {
  for (const scope of [body, field(body, 'data')]) {
    for (const key of ['submitted_message_id', 'messageId', 'message_id', 'id']) {
      const v = field(scope, key);
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
  }
  return null;
}

function extractError(body: unknown): string | null {
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 300);
  for (const key of ['message', 'errorMessage', 'error', 'msg']) {
    const v = field(body, key);
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
    const nested = field(v, 'message');
    if (typeof nested === 'string' && nested.trim()) return nested.trim().slice(0, 300);
  }
  return null;
}

/** A 2xx that still says it failed: { success: false } or { success: "false" }. */
function saysFailed(body: unknown): boolean {
  const s = field(body, 'success');
  return s === false || s === 'false';
}

/**
 * Turn an HTTP status + parsed body into a SendResult. Pure, so the classification
 * is unit-tested without a network:
 *   2xx                → sent (unless the body says success: false → permanent)
 *   401 / 403          → retryable: a bad or rotated API key is fixed in config, and
 *                        the messages should flow once it is — not be thrown away
 *   429 / 5xx          → retryable
 *   any other 4xx      → permanent (campaign not live, wrong param count, bad number)
 */
export function interpretAisensyResponse(
  status: number,
  body: unknown,
  ctx: { campaignName: string; mobile: string; nowMs: number },
): SendResult {
  const detail = extractError(body);
  if (status >= 200 && status < 300) {
    if (saysFailed(body)) return { ok: false, retryable: false, error: `AiSensy refused: ${detail ?? 'success=false'}` };
    const id = extractId(body) ?? `aisensy:${ctx.campaignName}:${ctx.mobile}:${ctx.nowMs}`;
    return { ok: true, providerMessageId: id, status: 'sent', providerRef: ctx.campaignName };
  }
  const error = `AiSensy HTTP ${status}${detail ? `: ${detail}` : ''} (campaign ${ctx.campaignName})`;
  if (status === 401 || status === 403 || status === 429 || status >= 500) return { ok: false, retryable: true, error };
  return { ok: false, retryable: false, error };
}

/* ----------------------------------------------------------------- send -- */

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
let fetchOverride: FetchImpl | undefined;
/** Test seam: route AiSensy calls through an injected fetch. */
export function __setAisensyFetchForTests(f: FetchImpl | undefined): void {
  fetchOverride = f;
}

export const aisensyProvider: NotifyProvider = {
  name: 'aisensy',
  async send(req: SendRequest): Promise<SendResult> {
    const cfg = aisensyConfig();
    const lang = sendLang(req.lang, cfg);

    // AiSensy rejects a call whose templateParams do not match the campaign, so a
    // missing param is caught here, as a permanent error naming the param.
    try {
      render(req.template, lang, req.params);
    } catch (err) {
      return { ok: false, retryable: false, error: err instanceof Error ? err.message : String(err) };
    }

    const payload = buildAisensyPayload({ ...req, lang }, cfg);
    const doFetch: FetchImpl = fetchOverride ?? ((url, init) => fetch(url, init));

    let res: Response;
    try {
      res = await doFetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // network failure or timeout — transient. Never echo the payload (it holds the key).
      return { ok: false, retryable: true, error: `AiSensy unreachable: ${err instanceof Error ? err.name : 'network error'}` };
    }

    const text = await res.text().catch(() => '');
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body: keep the text for the error message */
    }
    return interpretAisensyResponse(res.status, body, { campaignName: payload.campaignName, mobile: req.mobile, nowMs: Date.now() });
  },
};
