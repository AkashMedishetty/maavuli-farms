import { ok, readJson, handleRouteError } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { actorFor, requireSignedIn } from '@/lib/roles';
import { parsePreferencesInput, updatePreferences } from '@/lib/account';

export const dynamic = 'force-dynamic';

/**
 * POST /api/account/preferences
 *   { whatsappOptIn?: boolean, missedDeliveryPreference?: 'makeup_day'|'credit',
 *     notifyDailyDelivered?: boolean, lang?: 'en'|'te' }   (at least one)
 * → { profile }
 */
export async function POST(req: Request) {
  try {
    const p = await requireSignedIn();
    const input = parsePreferencesInput(await readJson(req));
    const profile = await updatePreferences(p.mobile, input, ctxFor(req, actorFor(p, 'customer')));
    return ok({ profile: { ...profile } });
  } catch (err) {
    return handleRouteError(err);
  }
}
