import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col, type Zone } from '@/lib/models';
import { requireAdmin, NotAdminError } from '@/lib/admin';
import { circleToPolygon, pointsToPolygon, normalizePoint } from '@/lib/geo';
import { listZones } from '@/lib/serviceability';

/**
 * Delivery zones — the admin-configurable replacement for the pincode list.
 *
 * GET    list every zone (active and not), for the admin map
 * POST   create a circle ({ name, lat, lng, radiusM }) or a polygon ({ name, points })
 * PATCH  { id, active }  toggle a zone on or off
 * DELETE ?id=…           remove a zone
 *
 * Two deliberate properties:
 *
 *  · The GeoJSON `geometry` is DERIVED here on the server from the operator's
 *    input, never accepted from the client. A client-supplied polygon could be
 *    wound the wrong way, and a reversed ring makes MongoDB match the COMPLEMENT
 *    of the intended area — "everywhere except this zone" — which fails OPEN. A
 *    delivery-area check must never fail open.
 *
 *  · Creating a zone is the act that makes us promise delivery somewhere, so it is
 *    admin-gated by the mobile allowlist, exactly like the fulfilment panel.
 */

export const dynamic = 'force-dynamic';

const MAX_RADIUS_M = 60_000; // a 60km circle already covers greater Hyderabad
const MIN_RADIUS_M = 100;

async function gate(): Promise<NextResponse | null> {
  try {
    await requireAdmin();
    return null;
  } catch (err) {
    if (err instanceof NotAdminError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
}

function notConfigured(err: unknown): NextResponse | null {
  if (err instanceof NotConfiguredError) {
    return NextResponse.json(
      { error: 'Database not configured', missing: err.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET(): Promise<NextResponse> {
  const denied = await gate();
  if (denied) return denied;
  try {
    const zones = await listZones();
    return NextResponse.json({
      zones: zones.map(z => ({
        id: z._id?.toHexString(),
        name: z.name,
        active: z.active,
        shape: z.shape,
        note: z.note ?? null,
      })),
    });
  } catch (err) {
    return notConfigured(err) ?? NextResponse.json({ error: 'Could not list zones.' }, { status: 503 });
  }
}

interface PostBody {
  name?: unknown;
  lat?: unknown;
  lng?: unknown;
  radiusM?: unknown;
  points?: unknown;
  note?: unknown;
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = await gate();
  if (denied) return denied;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'A zone name is required.' }, { status: 400 });
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;

  let shape: Zone['shape'];
  let geometry: Zone['geometry'];

  if (Array.isArray(body.points)) {
    const pts = [];
    for (const raw of body.points) {
      const o = raw as { lat?: unknown; lng?: unknown };
      const p = normalizePoint(o?.lat, o?.lng);
      if (!p) return NextResponse.json({ error: 'Every polygon point needs a valid lat and lng.' }, { status: 400 });
      pts.push(p);
    }
    if (pts.length < 3) {
      return NextResponse.json({ error: 'A polygon zone needs at least 3 points.' }, { status: 400 });
    }
    shape = { kind: 'polygon', points: pts };
    geometry = pointsToPolygon(pts) as Zone['geometry'];
  } else {
    const centre = normalizePoint(body.lat, body.lng);
    if (!centre) {
      return NextResponse.json(
        { error: 'A valid lat and lng are required (or a points array for a polygon).' },
        { status: 400 },
      );
    }
    const radiusM = typeof body.radiusM === 'string' ? Number(body.radiusM) : body.radiusM;
    if (typeof radiusM !== 'number' || !Number.isFinite(radiusM) || radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) {
      return NextResponse.json(
        { error: `radiusM must be a number between ${MIN_RADIUS_M} and ${MAX_RADIUS_M} metres.` },
        { status: 400 },
      );
    }
    shape = { kind: 'circle', centre, radiusM };
    geometry = circleToPolygon(centre, radiusM) as Zone['geometry'];
  }

  try {
    const db = await getDb();
    const now = new Date();
    const res = await col.zones(db).insertOne({
      name,
      active: true,
      shape,
      geometry,
      ...(note ? { note } : {}),
      createdAt: now,
      updatedAt: now,
    } as Zone);
    return NextResponse.json({ id: res.insertedId.toHexString(), name, active: true });
  } catch (err) {
    return notConfigured(err) ?? NextResponse.json({ error: 'Could not save the zone.' }, { status: 503 });
  }
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const denied = await gate();
  if (denied) return denied;

  let body: { id?: unknown; active?: unknown };
  try {
    body = (await req.json()) as { id?: unknown; active?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const id = typeof body.id === 'string' && ObjectId.isValid(body.id) ? new ObjectId(body.id) : null;
  if (!id) return NextResponse.json({ error: 'A valid zone id is required.' }, { status: 400 });
  if (typeof body.active !== 'boolean') {
    return NextResponse.json({ error: 'active must be true or false.' }, { status: 400 });
  }

  try {
    const db = await getDb();
    const res = await col.zones(db).updateOne(
      { _id: id },
      { $set: { active: body.active, updatedAt: new Date() } },
    );
    if (res.matchedCount === 0) return NextResponse.json({ error: 'Unknown zone.' }, { status: 404 });
    return NextResponse.json({ id: body.id, active: body.active });
  } catch (err) {
    return notConfigured(err) ?? NextResponse.json({ error: 'Could not update the zone.' }, { status: 503 });
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const denied = await gate();
  if (denied) return denied;

  const raw = new URL(req.url).searchParams.get('id') ?? '';
  if (!ObjectId.isValid(raw)) {
    return NextResponse.json({ error: 'A valid zone id is required.' }, { status: 400 });
  }

  try {
    const db = await getDb();
    const res = await col.zones(db).deleteOne({ _id: new ObjectId(raw) });
    if (res.deletedCount === 0) return NextResponse.json({ error: 'Unknown zone.' }, { status: 404 });
    return NextResponse.json({ deleted: raw });
  } catch (err) {
    return notConfigured(err) ?? NextResponse.json({ error: 'Could not delete the zone.' }, { status: 503 });
  }
}
