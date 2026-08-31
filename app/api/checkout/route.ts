import { NextResponse } from 'next/server';
import { razorpayConfig } from '@/lib/env';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col, normalizeMobile } from '@/lib/models';
import { quote, type MilkKind } from '@/lib/pricing';
import { createOrder } from '@/lib/razorpay';
import { isServiceable, isServiceablePoint, activeZoneCount } from '@/lib/serviceability';
import { normalizePoint } from '@/lib/geo';

/**
 * POST /api/checkout
 *
 * Creates a prepaid Razorpay Order for a fixed-term milk plan and records an
 * `orders` row in status 'created' with a FROZEN quote snapshot.
 *
 * Two rules dominate this handler:
 *   1. The amount is RECOMPUTED server-side from lib/pricing. A client-supplied
 *      amount is never read — that is the classic price-tampering hole.
 *   2. The quote is snapshotted onto the order. A past order is never recomputed;
 *      if the price matrix changes tomorrow, yesterday's paid order is unaffected.
 */

const KINDS: readonly MilkKind[] = ['buffalo', 'cow'];

interface CheckoutBody {
  mobile?: unknown;
  kind?: unknown;
  name?: unknown;
  landmark?: unknown;
  lat?: unknown;
  lng?: unknown;
  quantityId?: unknown;
  tenureId?: unknown;
  pincode?: unknown;
  address?: unknown;
}

function bad(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  // Razorpay config first — an unconfigured payment service answers 503 with the
  // exact missing variable names, it never silently no-ops.
  const cfg = razorpayConfig();
  if (!cfg.ok) {
    return NextResponse.json(
      { error: 'Payments are not configured', missing: cfg.missing },
      { status: 503 },
    );
  }

  let body: CheckoutBody;
  try {
    body = (await req.json()) as CheckoutBody;
  } catch {
    return bad('Invalid JSON body', 400);
  }

  // --- validate inputs -----------------------------------------------------
  if (typeof body.mobile !== 'string') return bad('mobile is required', 400);
  const mobile = normalizeMobile(body.mobile);
  if (!mobile) return bad('Invalid mobile number', 400);

  if (typeof body.kind !== 'string' || !KINDS.includes(body.kind as MilkKind)) {
    return bad('Invalid milk kind', 400);
  }
  const kind = body.kind as MilkKind;

  if (typeof body.quantityId !== 'string') return bad('quantityId is required', 400);
  if (typeof body.tenureId !== 'string') return bad('tenureId is required', 400);

  if (typeof body.pincode !== 'string' || !/^\d{6}$/.test(body.pincode.trim())) {
    return bad('Invalid pincode', 400);
  }
  const pincode = body.pincode.trim();

  /*
   * A DELIVERY needs more than a pincode.
   *
   * Name and address are required, not optional: a rider cannot deliver to
   * "500047". The location point is optional — plenty of customers will decline the
   * browser permission, and refusing their order for that would be absurd — but
   * when it is given it becomes the authoritative serviceability check, because a
   * point inside a drawn zone is a far stronger promise than a pincode that may
   * span kilometres.
   */
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 2) return bad('A name for the delivery is required', 400);

  const landmark = typeof body.landmark === 'string' && body.landmark.trim() !== ''
    ? body.landmark.trim()
    : undefined;

  const point = normalizePoint(body.lat, body.lng);

  const addressRaw = typeof body.address === 'string' ? body.address.trim() : '';
  if (addressRaw.length < 10) {
    return bad('A delivery address is required (flat or house, street and area)', 400);
  }

  const address = typeof body.address === 'string' && body.address.trim() !== ''
    ? body.address.trim()
    : undefined;

  // --- recompute the price authoritatively ---------------------------------
  // quote() throws on an unknown quantityId/tenureId, which is a 400, not a 500.
  let q;
  try {
    q = quote(kind, body.quantityId, body.tenureId);
  } catch {
    return bad('Invalid plan selection', 400);
  }

  try {
    // --- serviceability (authoritative by pincode) -------------------------
    // Owned by another agent's lib/serviceability. An empty pincodes collection
    // must mean "we deliver nowhere", so a false here is a hard 409.
    /*
     * Geo first when we can: a point checked against a drawn zone is the promise we
     * actually want to make. Falls back to the pincode list when the customer did
     * not share a location, or when no zones are configured yet — so this works
     * during the migration instead of requiring a flag day.
     */
    let serviceable: boolean;
    if (point && (await activeZoneCount()) > 0) {
      serviceable = await isServiceablePoint(point);
      if (!serviceable) {
        return bad('That address is outside our delivery area at the moment.', 409);
      }
    } else {
      serviceable = await isServiceable(pincode);
      if (!serviceable) {
        return bad(`We do not deliver to ${pincode} yet.`, 409);
      }
    }

    const db = await getDb();

    // Create the Razorpay Order with the server-computed amount.
    const rzpOrder = await createOrder({
      amountPaise: q.finalPaise,
      receipt: `mvl_${mobile}_${Date.now()}`,
      notes: { mobile, kind, quantityId: q.quantityId, tenureId: q.tenureId, pincode },
    });

    // Persist the order with the frozen quote snapshot.
    await col.orders(db).insertOne({
      razorpayOrderId: rzpOrder.id,
      mobile,
      kind,
      quantityId: q.quantityId,
      tenureId: q.tenureId,
      amountPaise: q.finalPaise,
      perLitrePaise: q.perLitrePaise,
      days: q.days,
      litres: q.litres,
      pincode,
      name,
      address,
      ...(landmark ? { landmark } : {}),
      ...(point ? { location: { lat: point.lat, lng: point.lng } } : {}),
      status: 'created',
      createdAt: new Date(),
    });

    /*
     * Remember the customer so a repeat purchase does not retype all of this. Upsert
     * rather than insert: the account already exists from the OTP sign-in, and we
     * must not clobber it. $setOnInsert guards createdAt.
     */
    await col.users(db).updateOne(
      { mobile },
      {
        $set: { name, address, pincode, lastSeenAt: new Date() },
        $setOnInsert: { mobile, createdAt: new Date() },
      },
      { upsert: true },
    );

    // keyId is public (it goes to the browser checkout); the secret never leaves.
    return NextResponse.json({
      razorpayOrderId: rzpOrder.id,
      amountPaise: q.finalPaise,
      keyId: cfg.value.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return NextResponse.json(
        { error: 'Database not configured', missing: err.missing },
        { status: 503 },
      );
    }
    // Never leak internals on a money path.
    return bad('Could not start checkout. Please try again.', 500);
  }
}
