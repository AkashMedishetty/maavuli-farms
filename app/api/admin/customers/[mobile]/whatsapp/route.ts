import { getDb } from '@/lib/db';
import { col, normalizeMobile } from '@/lib/models';
import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { setWhatsappOptIn } from '@/lib/notify/optin';

export const dynamic = 'force-dynamic';

/**
 * POST {optIn: false} — turn WhatsApp off because the customer asked (phone call,
 * in person). All staff. Staff can only turn it OFF: Meta requires the opt-in to be
 * the customer's own act, so turning it on stays with the customer (account page /
 * checkout).
 */
export async function POST(req: Request, { params }: { params: Promise<{ mobile: string }> }) {
  try {
    const p = await requireStaff(['owner', 'ops', 'support']);
    const { mobile: raw } = await params;
    const mobile = normalizeMobile(raw);
    if (!mobile) throw new NotFoundError('Customer not found');
    const body = await readJson<{ optIn?: unknown }>(req);
    if (body.optIn !== false) {
      throw new ValidationError('Staff can only turn WhatsApp off', ['optIn must be false — the customer turns it on themselves']);
    }
    const db = await getDb();
    if (!(await col.users(db).countDocuments({ mobile }, { limit: 1 }))) throw new NotFoundError('Customer not found');
    await setWhatsappOptIn(mobile, false, 'staff', ctxFor(req, actorFor(p, 'staff')));
    return ok({ mobile, whatsappOptIn: false });
  } catch (err) {
    return handleRouteError(err);
  }
}
