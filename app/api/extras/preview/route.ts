import { previewExtra } from '@/lib/extras';
import { actorFor, requireSignedIn } from '@/lib/roles';
import { ctxFor } from '@/lib/clock';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { parseExtraBody } from '../_input';

export const dynamic = 'force-dynamic';

/** POST /api/extras/preview {subscriptionId, date, kind, litres, useCredit} — price, credit, payable; no writes. */
export async function POST(req: Request) {
  try {
    const p = await requireSignedIn();
    const input = parseExtraBody(await readJson(req), p.mobile, false);
    const { idempotencyKey, ...rest } = input;
    void idempotencyKey;
    const preview = await previewExtra(rest, ctxFor(req, actorFor(p, 'customer')));
    return ok({ preview: { ...preview } });
  } catch (err) {
    return handleRouteError(err);
  }
}
