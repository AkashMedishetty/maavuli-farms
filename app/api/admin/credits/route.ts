import { getDb } from '@/lib/db';
import { col, normalizeMobile, type StaffRole } from '@/lib/models';
import { addCredit } from '@/lib/credits';
import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { formatINR } from '@/lib/pricing';

export const dynamic = 'force-dynamic';

/** Per-entry goodwill caps (PLATFORM-CONTRACT §4). */
const GOODWILL_CAP_PAISE: Readonly<Record<StaffRole, number>> = {
  support: 20_000,
  ops: 100_000,
  owner: 1_000_000,
};

/** POST /api/admin/credits {mobile, amountPaise, note} — goodwill credit, not refundable. */
export async function POST(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops', 'support']);
    const body = await readJson<{ mobile?: unknown; amountPaise?: unknown; note?: unknown }>(req);
    const issues: string[] = [];
    const mobile = typeof body.mobile === 'string' ? normalizeMobile(body.mobile) : null;
    if (!mobile) issues.push('mobile must be a 10-digit Indian mobile');
    const amount = body.amountPaise;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) issues.push('amountPaise must be a positive whole number of paise');
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length < 3 || note.length > 300) issues.push('note must be 3–300 characters (why this credit is given)');
    if (issues.length || !mobile || typeof amount !== 'number') throw new ValidationError('Invalid credit', issues);

    const cap = GOODWILL_CAP_PAISE[p.staffRole];
    if (amount > cap) throw new ForbiddenError(`Your role can give at most ${formatINR(cap)} per entry.`);

    const db = await getDb();
    if (!(await col.users(db).countDocuments({ mobile }, { limit: 1 }))) throw new NotFoundError('No customer with that mobile');

    const entry = await addCredit(
      { mobile, amountPaise: amount, kind: 'goodwill', refundable: false, note },
      ctxFor(req, actorFor(p, 'staff')),
    );
    return ok({ credit: { id: entry._id?.toHexString() ?? null, mobile, amountPaise: amount, kind: 'goodwill', note } }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
