// Server-only module (imports lib/db). Imported solely by the server page.tsx.
import { ObjectId } from 'mongodb';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col } from '@/lib/models';
import { getPrincipal } from '@/lib/roles';
import { renewalTarget } from '@/lib/subscriptions';
import { customerActor, pageNow } from '@/lib/clock';
import { QUANTITIES, TENURES } from '@/lib/pricing';
import { ServiceNotConfiguredError } from '@/lib/errors';
import type { RenewalProp } from './types';

/**
 * Resolve `/subscribe?renew=<subscriptionId>` for the SIGNED-IN customer.
 *
 * Only the customer's own subscription is ever read (mobile is part of the query),
 * and "someone else's" is answered exactly like "does not exist" — the page never
 * confirms that an id belongs to another account.
 */
export async function loadRenewal(raw: string | undefined): Promise<RenewalProp> {
  if (!raw) return { kind: 'none' };
  if (!ObjectId.isValid(raw) || raw.length !== 24) return { kind: 'not_found' };
  try {
    const p = await getPrincipal();
    if (!p) return { kind: 'signed_out' };
    const db = await getDb();
    const id = new ObjectId(raw);
    const sub = await col.subscriptions(db).findOne({ _id: id, mobile: p.mobile });
    if (!sub?._id) return { kind: 'not_found' };

    const ctx = { now: await pageNow(), actor: customerActor(p.mobile) };
    const target = await renewalTarget(p.mobile, id, ctx);
    if (!target) {
      const reason = sub.renewedBy
        ? 'This plan already has a renewal queued. You can see it in My Deliveries.'
        : sub.status === 'cancelled'
          ? 'This plan was cancelled, so it cannot be renewed. You can start a new plan instead.'
          : 'This plan has ended, so it cannot be renewed. You can start a new plan instead.';
      return { kind: 'not_renewable', reason };
    }

    const order = await col.orders(db).findOne({ _id: sub.orderId, mobile: p.mobile });
    const quantityId =
      (order && QUANTITIES.some((q) => q.id === order.quantityId) ? order.quantityId : null) ??
      QUANTITIES.find((q) => q.num * sub.qtyDen === sub.qtyNum * q.den)?.id ??
      null;
    const tenureId = order && TENURES.some((t) => t.id === order.tenureId) ? order.tenureId : null;

    return {
      kind: 'ready',
      subscriptionId: raw,
      endDate: sub.endDate,
      renewStartDate: target.renewStartDate,
      milk: sub.kind,
      quantityId,
      tenureId,
      details: {
        name: sub.name ?? order?.name ?? '',
        address: sub.address ?? order?.address ?? '',
        ...(sub.landmark ? { landmark: sub.landmark } : {}),
        ...(sub.instructions ? { instructions: sub.instructions } : {}),
        ...(sub.addressParts ? { addressParts: { ...sub.addressParts } } : {}),
        ...(sub.location ? { location: { lat: sub.location.lat, lng: sub.location.lng } } : {}),
      },
    };
  } catch (err) {
    if (err instanceof NotConfiguredError || err instanceof ServiceNotConfiguredError) {
      return { kind: 'unavailable', missing: [...err.missing] };
    }
    // eslint-disable-next-line no-console
    console.error('[subscribe] renewal load failed', err instanceof Error ? err.message : err);
    return { kind: 'unavailable', missing: [] };
  }
}
