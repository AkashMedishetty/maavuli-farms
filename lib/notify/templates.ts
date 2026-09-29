/**
 * The template registry. OWNER: B6.
 *
 * Every WhatsApp message the platform sends is a pre-approved Meta template. This
 * file is the single source of truth for:
 *   · which templates exist (keyed by our internal TemplateName),
 *   · the Meta-side template `name` we submit for approval,
 *   · the template CATEGORY (utility vs authentication) — Meta re-categorises copy
 *     that reads as promotional to "marketing", which changes pricing and opt-in
 *     rules, so every string here is deliberately short, plain and transactional,
 *   · the ORDERED positional params ({{1}}, {{2}}, …) each template takes, and
 *   · the English body and a Telugu DRAFT (marked NEEDS NATIVE REVIEW).
 *
 * `render()` fills the params into a body string. It is used by the 'log' provider
 * (to record exactly what would have been sent) and by the admin message preview.
 * The live 'meta' provider does NOT use render() — it sends the template `name` +
 * positional components and Meta renders the approved copy on its side.
 *
 * PURE module: no DB, no '@/...' imports, no clock. Tests import it relatively.
 */

import type { Lang } from '../models';
import type { TemplateName } from './index';

export type TemplateCategory = 'utility' | 'authentication';

/** The internal name of the sign-in-code template. Meta name comes from env at send time. */
export const AUTH_TEMPLATE: 'auth_code' = 'auth_code';

/** Every renderable template name: the business templates plus the auth template. */
export type RenderableTemplate = TemplateName | typeof AUTH_TEMPLATE;

export interface TemplateDef {
  /** Meta-side template name submitted for approval (snake_case, ≤512 chars). */
  metaName: string;
  category: TemplateCategory;
  /**
   * Ordered param keys. Position i in this array is Meta placeholder {{i+1}}.
   * `render()` and the meta provider both read params in THIS order, so the two
   * never drift. A template with no variables has an empty array.
   */
  params: readonly string[];
  /** Body copy per language. `te` is a draft — see NEEDS_NATIVE_REVIEW. */
  body: Record<Lang, string>;
}

/**
 * The Telugu strings below are a first-pass DRAFT produced without a native
 * reviewer. They are structurally correct (same placeholders, same order) but the
 * wording MUST be reviewed by a Telugu speaker before these templates are submitted
 * to Meta. Tracked as a business question in the report.
 */
export const NEEDS_NATIVE_REVIEW = true;

/**
 * Placeholders are written as {{name}} in the copy for readability; render()
 * substitutes by NAME. Meta only understands {{1}}, {{2}}, … — the meta provider
 * maps `params` positionally, so the human-readable names here never reach Meta.
 */
export const TEMPLATES: Readonly<Record<RenderableTemplate, TemplateDef>> = {
  order_confirmed: {
    metaName: 'order_confirmed',
    category: 'utility',
    params: ['name', 'plan', 'startDate', 'endDate', 'amount'],
    body: {
      en: 'Hi {{name}}, your Maavuli {{plan}} plan is confirmed. Deliveries run {{startDate}} to {{endDate}}. Paid: {{amount}}.',
      te: 'నమస్తే {{name}}, మీ మావూలి {{plan}} ప్లాన్ నిర్ధారించబడింది. డెలివరీలు {{startDate}} నుండి {{endDate}} వరకు. చెల్లించినది: {{amount}}.',
    },
  },
  first_delivery_tomorrow: {
    metaName: 'first_delivery_tomorrow',
    category: 'utility',
    params: ['date', 'window'],
    body: {
      en: 'Your first Maavuli delivery is on {{date}}, between {{window}}. Please keep your gate accessible.',
      te: 'మీ మొదటి మావూలి డెలివరీ {{date}}న, {{window}} మధ్య వస్తుంది. దయచేసి గేటు తెరిచి ఉంచండి.',
    },
  },
  delivered_today: {
    metaName: 'delivered_today',
    category: 'utility',
    params: ['time'],
    body: {
      en: 'Your milk was delivered today at {{time}}. Thank you.',
      te: 'మీ పాలు ఈరోజు {{time}}కి డెలివరీ చేయబడ్డాయి. ధన్యవాదాలు.',
    },
  },
  not_delivered_ours: {
    metaName: 'not_delivered_ours',
    category: 'utility',
    params: ['date', 'resolution'],
    body: {
      en: 'We could not deliver your milk on {{date}}. {{resolution}}. Sorry for the trouble.',
      te: '{{date}}న మేము మీ పాలు డెలివరీ చేయలేకపోయాము. {{resolution}}. అసౌకర్యానికి క్షమించండి.',
    },
  },
  not_delivered_customer: {
    metaName: 'not_delivered_customer',
    category: 'utility',
    params: ['date', 'reason'],
    body: {
      en: 'Your milk could not be delivered on {{date}} ({{reason}}). Please check your account for details.',
      te: '{{date}}న మీ పాలు డెలివరీ చేయలేకపోయాము ({{reason}}). వివరాల కోసం మీ ఖాతా చూడండి.',
    },
  },
  pause_confirmed: {
    metaName: 'pause_confirmed',
    category: 'utility',
    params: ['dates', 'endDate'],
    body: {
      en: 'Your Maavuli deliveries are paused for {{dates}}. Your plan now ends on {{endDate}}.',
      te: 'మీ మావూలి డెలివరీలు {{dates}} కోసం నిలిపివేయబడ్డాయి. మీ ప్లాన్ ఇప్పుడు {{endDate}}న ముగుస్తుంది.',
    },
  },
  cancellation_confirmed: {
    metaName: 'cancellation_confirmed',
    category: 'utility',
    params: ['lastDate', 'refund'],
    body: {
      en: 'Your Maavuli plan is cancelled. Last delivery: {{lastDate}}. Refund: {{refund}}.',
      te: 'మీ మావూలి ప్లాన్ రద్దు చేయబడింది. చివరి డెలివరీ: {{lastDate}}. వాపసు: {{refund}}.',
    },
  },
  refund_processed: {
    metaName: 'refund_processed',
    category: 'utility',
    params: ['amount'],
    body: {
      en: 'Your Maavuli refund of {{amount}} has been processed.',
      te: 'మీ మావూలి వాపసు {{amount}} ప్రాసెస్ చేయబడింది.',
    },
  },
  refund_needs_upi: {
    metaName: 'refund_needs_upi',
    category: 'utility',
    params: ['amount', 'link'],
    body: {
      en: 'Your refund of {{amount}} needs a UPI ID to complete. Please add it here: {{link}}',
      te: 'మీ {{amount}} వాపసు పూర్తి చేయడానికి UPI ID అవసరం. దయచేసి ఇక్కడ జోడించండి: {{link}}',
    },
  },
  renewal_reminder: {
    metaName: 'renewal_reminder',
    category: 'utility',
    params: ['daysLeft', 'endDate', 'link'],
    body: {
      en: 'Your Maavuli plan ends in {{daysLeft}} days (on {{endDate}}). Renew here to avoid a gap: {{link}}',
      te: 'మీ మావూలి ప్లాన్ {{daysLeft}} రోజుల్లో ({{endDate}}న) ముగుస్తుంది. అంతరాయం లేకుండా ఇక్కడ రెన్యూ చేయండి: {{link}}',
    },
  },
  extra_confirmed: {
    metaName: 'extra_confirmed',
    category: 'utility',
    params: ['date', 'litres', 'kind'],
    body: {
      en: 'Your extra {{litres}} of {{kind}} milk is confirmed for {{date}}.',
      te: '{{date}}న మీ అదనపు {{litres}} {{kind}} పాలు నిర్ధారించబడ్డాయి.',
    },
  },
  disruption_notice: {
    metaName: 'disruption_notice',
    category: 'utility',
    params: ['date', 'reason', 'resolution'],
    body: {
      en: 'Deliveries on {{date}} are affected by {{reason}}. {{resolution}}.',
      te: '{{date}}న డెలివరీలు {{reason}} వలన ప్రభావితమయ్యాయి. {{resolution}}.',
    },
  },
  ticket_update: {
    metaName: 'ticket_update',
    category: 'utility',
    params: ['status', 'note'],
    body: {
      en: 'Update on your Maavuli request: {{status}}. {{note}}',
      te: 'మీ మావూలి అభ్యర్థనపై అప్‌డేట్: {{status}}. {{note}}',
    },
  },
  auth_code: {
    // Meta name is overridable via WHATSAPP_AUTH_TEMPLATE at send time; this is the
    // default/fallback we submit for the authentication category.
    metaName: 'auth_code',
    category: 'authentication',
    params: ['code'],
    body: {
      en: '{{code}} is your Maavuli sign-in code. It expires in 5 minutes. Do not share it.',
      te: '{{code}} మీ మావూలి సైన్-ఇన్ కోడ్. ఇది 5 నిమిషాల్లో గడువు ముగుస్తుంది. దీన్ని ఎవరితోనూ పంచుకోవద్దు.',
    },
  },
};

export function isTemplateName(name: string): name is RenderableTemplate {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, name);
}

/** The ordered positional param values for the meta provider ({{1}}..{{n}}). */
export function orderedParams(template: RenderableTemplate, params: Record<string, string>): string[] {
  return TEMPLATES[template].params.map(k => params[k] ?? '');
}

export class TemplateParamError extends Error {
  constructor(
    public template: string,
    public missing: string[],
  ) {
    super(`Template "${template}" is missing params: ${missing.join(', ')}`);
    this.name = 'TemplateParamError';
  }
}

/** Which declared params are absent (or empty) in `params`. */
export function missingParams(template: RenderableTemplate, params: Record<string, string>): string[] {
  return TEMPLATES[template].params.filter(k => {
    const v = params[k];
    return v === undefined || v === '';
  });
}

/**
 * Fill `params` into the template body for `lang`, throwing TemplateParamError when
 * a declared param is missing. Falls back to English when a language body is absent
 * (every template currently carries both, but the fallback keeps a future language
 * from producing an empty string). Unknown template → throws.
 */
export function render(template: RenderableTemplate, lang: Lang, params: Record<string, string>): string {
  const def = TEMPLATES[template];
  if (!def) throw new TemplateParamError(String(template), []);
  const miss = missingParams(template, params);
  if (miss.length) throw new TemplateParamError(String(template), miss);
  const body = def.body[lang] ?? def.body.en;
  return def.params.reduce(
    (acc, key) => acc.replaceAll(`{{${key}}}`, params[key] ?? ''),
    body,
  );
}
