import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { NotConfiguredError } from '@/lib/db';
import { col } from '@/lib/models';
import { requireAdmin, NotAdminError, isSettableDeliveryStatus } from '@/lib/admin';

// a round is read live; nothing here may be statically cached
export const dynamic = 'force-dynamic';

/**
 * Mark one delivery delivered / skipped / failed, with an optional note.
 *
 * The status is validated against the writable subset of the DeliveryStatus union
 * (never 'scheduled' — that is the seed state, not something an admin sets by hand)
 * so an arbitrary string can never reach the database. requireAdmin runs first;
 * an unauthenticated or non-allowlisted caller gets 403 before any body is read.
 */
export async function POST(req: Request): Promise<NextResponse> {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdminError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { deliveryId, status, note } = (body ?? {}) as {
    deliveryId?: unknown;
    status?: unknown;
    note?: unknown;
  };

  if (typeof deliveryId !== 'string' || !ObjectId.isValid(deliveryId)) {
    return NextResponse.json({ error: 'deliveryId must be a valid id' }, { status: 400 });
  }
  if (!isSettableDeliveryStatus(status)) {
    return NextResponse.json(
      { error: 'status must be one of: delivered, skipped, failed' },
      { status: 400 },
    );
  }
  if (note !== undefined && typeof note !== 'string') {
    return NextResponse.json({ error: 'note must be a string' }, { status: 400 });
  }

  try {
    const db = await getDb();
    const set: { status: typeof status; updatedAt: Date; note?: string } = {
      status,
      updatedAt: new Date(),
    };
    // an empty note clears; a present note is trimmed
    if (note !== undefined) {
      const trimmed = note.trim();
      if (trimmed) set.note = trimmed;
    }

    const res = await col
      .deliveries(db)
      .updateOne({ _id: new ObjectId(deliveryId) }, { $set: set });

    if (res.matchedCount === 0) {
      return NextResponse.json({ error: 'Delivery not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deliveryId, status });
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return NextResponse.json(
        { error: 'Database not configured', missing: err.missing },
        { status: 503 },
      );
    }
    throw err;
  }
}
