/**
 * Shared helpers for the customer subscription routes. Not a route (no route.ts).
 * Ownership rule: another customer's subscription is a 404, never a 403.
 */
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, type Subscription } from '@/lib/models';
import { NotFoundError } from '@/lib/errors';
import type { Principal } from '@/lib/roles';

export async function ownSubscription(
  params: Promise<{ id: string }>,
  p: Principal,
): Promise<Subscription & { _id: ObjectId }> {
  const { id } = await params;
  if (!ObjectId.isValid(id) || String(new ObjectId(id)) !== id.toLowerCase()) throw new NotFoundError('Subscription not found');
  const db = await getDb();
  const sub = await col.subscriptions(db).findOne({ _id: new ObjectId(id) });
  if (!sub?._id || sub.mobile !== p.mobile) throw new NotFoundError('Subscription not found');
  return sub as Subscription & { _id: ObjectId };
}
