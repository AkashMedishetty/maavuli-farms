/**
 * WhatsApp opt-in state. OWNER: B6.
 *
 * Meta requires an explicit, recorded opt-in before a business sends template
 * messages. `whatsappOptIn` on the user is that flag; this module is the ONE place
 * it is flipped, so every change is audited with who/when/how (`source`).
 *
 * Opt-out comes in from the webhook (a STOP message) as well as the account UI, so
 * `source` distinguishes them for the audit trail.
 */

import { getDb } from '../db';
import { col, normalizeMobile } from '../models';
import { recordEvent } from '../events';
import type { OpCtx } from '../clock';

export type OptInSource = 'account' | 'checkout' | 'whatsapp_stop' | 'staff';

/**
 * Set (or clear) a customer's WhatsApp opt-in. No-op-safe: setting the same value
 * again still records the event (the customer's intent was expressed) but is cheap.
 * Never throws for a missing user — an opt-out for an unknown mobile is harmless.
 */
export async function setWhatsappOptIn(
  mobile: string,
  on: boolean,
  source: OptInSource,
  ctx: OpCtx,
): Promise<void> {
  const normalized = normalizeMobile(mobile);
  if (!normalized) return;

  const db = await getDb();
  await col.users(db).updateOne(
    { mobile: normalized },
    on
      ? { $set: { whatsappOptIn: true, whatsappOptInAt: ctx.now } }
      : { $set: { whatsappOptIn: false }, $unset: { whatsappOptInAt: '' } },
    { upsert: false },
  );

  await recordEvent(
    ctx,
    {
      entity: 'customer',
      entityId: normalized,
      type: on ? 'customer.whatsapp_opt_in' : 'customer.whatsapp_opt_out',
      mobile: normalized,
      data: { source },
    },
    db,
  );
}
