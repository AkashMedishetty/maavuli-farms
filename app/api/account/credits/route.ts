import { creditBalance, creditHistory } from '@/lib/credits';
import { requireSignedIn } from '@/lib/roles';
import { handleRouteError, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** GET /api/account/credits — the signed-in customer's balance and recent ledger. */
export async function GET() {
  try {
    const p = await requireSignedIn();
    const [balance, history] = await Promise.all([creditBalance(p.mobile), creditHistory(p.mobile, 100)]);
    return ok({
      balancePaise: balance.balancePaise,
      refundablePaise: balance.refundablePaise,
      entries: history.map(e => ({
        id: e._id?.toHexString() ?? null,
        amountPaise: e.amountPaise,
        kind: e.kind,
        refundable: e.refundable,
        note: e.note ?? null,
        at: e.at.toISOString(),
      })),
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
