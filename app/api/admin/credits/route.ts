import { getDb } from '@/lib/db';
import { col, normalizeMobile } from '@/lib/models';
import { addCredit, GOODWILL_CAP_PAISE, withCreditLock } from '@/lib/credits';
import { actorFor, requireStaff } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { formatINR } from '@/lib/pricing';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/admin/credits {mobile, amountPaise, note} — goodwill credit, not refundable.
 * GOODWILL_CAP_PAISE caps each entry AND the rolling 24 h total to one customer.
 */
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

    const ctx = ctxFor(req, actorFor(p, 'staff'));
    // The cap is also an AGGREGATE: all goodwill to this customer in the last 24 h,
    // from every staff member, plus this entry. Read and write under the customer's
    // credit lease, so two requests at once cannot both pass the check.
    const entry = await withCreditLock(mobile, async d => {
      const since = new Date(ctx.now.getTime() - DAY_MS);
      const [agg] = await col
        .credits(d)
        .aggregate<{ total: number }>([
          { $match: { mobile, kind: 'goodwill', at: { $gte: since } } },
          { $group: { _id: null, total: { $sum: '$amountPaise' } } },
        ])
        .toArray();
      const given = agg?.total ?? 0;
      if (given + amount > cap) {
        throw new ForbiddenError(
          `This customer has had ${formatINR(given)} of goodwill in the last 24 hours. Your role can give at most ${formatINR(cap)} in total per customer per day — ask the owner to add more.`,
        );
      }
      return addCredit({ mobile, amountPaise: amount, kind: 'goodwill', refundable: false, note }, ctx);
    });
    return ok({ credit: { id: entry._id?.toHexString() ?? null, mobile, amountPaise: amount, kind: 'goodwill', note } }, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}
