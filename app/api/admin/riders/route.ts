import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb, NotConfiguredError } from '@/lib/db';
import { col, normalizeMobile, type Rider } from '@/lib/models';
import { requireAdmin, NotAdminError } from '@/lib/admin';
import { normalizePoint } from '@/lib/geo';

/**
 * Delivery riders — the people a zone's stops are assigned to.
 *
 * GET    list every rider
 * POST   create  { name, phone?, lat?, lng?, note? }
 * PATCH  { id, active? | name? | phone? | lat?,lng? | note? }  update fields
 * DELETE ?id=…    remove a rider (its zones fall back to "unassigned")
 *
 * Admin-gated by the mobile allowlist, exactly like zones and the fulfilment panel.
 * A rider is not a login, so `phone` is optional and only normalised for storage.
 */

export const dynamic = 'force-dynamic';

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
    return NextResponse.json({ error: 'Database not configured', missing: err.missing }, { status: 503 });
  }
  return null;
}

export async function GET(): Promise<NextResponse> {
  const denied = await gate();
  if (denied) return denied;
  try {
    const db = await getDb();
    const riders = await col.riders(db).find({}).sort({ name: 1 }).toArray();
    return NextResponse.json({
      riders: riders.map(r => ({
        id: r._id?.toHexString(),
        name: r.name,
        phone: r.phone ?? null,
        active: r.active,
        startLocation: r.startLocation ?? null,
        note: r.note ?? null,
      })),
    });
  } catch (err) {
    return notConfigured(err) ?? NextResponse.json({ error: 'Could not list riders.' }, { status: 503 });
  }
}

interface PostBody {
  name?: unknown;
  phone?: unknown;
  lat?: unknown;
  lng?: unknown;
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
  if (!name) return NextResponse.json({ error: 'A rider name is required.' }, { status: 400 });

  let phone: string | undefined;
  if (typeof body.phone === 'string' && body.phone.trim()) {
    const norm = normalizeMobile(body.phone);
    if (!norm) return NextResponse.json({ error: 'phone must be a valid 10-digit mobile.' }, { status: 400 });
    phone = norm;
  }

  let startLocation: { lat: number; lng: number } | undefined;
  if (body.lat != null && body.lng != null) {
    const p = normalizePoint(body.lat, body.lng);
    if (!p) return NextResponse.json({ error: 'startLocation lat/lng are invalid.' }, { status: 400 });
    startLocation = { lat: p.lat, lng: p.lng };
  }

  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;

  try {
    const db = await getDb();
    const now = new Date();
    const res = await col.riders(db).insertOne({
      name,
      active: true,
      ...(phone ? { phone } : {}),
      ...(startLocation ? { startLocation } : {}),
      ...(note ? { note } : {}),
      createdAt: now,
      updatedAt: now,
    } as Rider);
    return NextResponse.json({ id: res.insertedId.toHexString(), name, active: true });
  } catch (err) {
    return notConfigured(err) ?? NextResponse.json({ error: 'Could not save the rider.' }, { status: 503 });
  }
}

interface PatchBody {
  id?: unknown;
  active?: unknown;
  name?: unknown;
  phone?: unknown;
  lat?: unknown;
  lng?: unknown;
  note?: unknown;
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const denied = await gate();
  if (denied) return denied;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const id = typeof body.id === 'string' && ObjectId.isValid(body.id) ? new ObjectId(body.id) : null;
  if (!id) return NextResponse.json({ error: 'A valid rider id is required.' }, { status: 400 });

  // $set for fields being written; $unset for fields explicitly cleared (an empty
  // string) — Mongo needs $unset to remove a field, not $set to undefined.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const unset: Record<string, ''> = {};

  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') {
      return NextResponse.json({ error: 'active must be true or false.' }, { status: 400 });
    }
    set.active = body.active;
  }
  if (typeof body.name === 'string' && body.name.trim()) set.name = body.name.trim();
  if (typeof body.phone === 'string') {
    if (body.phone.trim() === '') {
      unset.phone = '';
    } else {
      const norm = normalizeMobile(body.phone);
      if (!norm) return NextResponse.json({ error: 'phone must be a valid 10-digit mobile.' }, { status: 400 });
      set.phone = norm;
    }
  }
  if (body.lat != null && body.lng != null) {
    const p = normalizePoint(body.lat, body.lng);
    if (!p) return NextResponse.json({ error: 'startLocation lat/lng are invalid.' }, { status: 400 });
    set.startLocation = { lat: p.lat, lng: p.lng };
  }
  if (typeof body.note === 'string') {
    if (body.note.trim() === '') unset.note = '';
    else set.note = body.note.trim();
  }

  const update: Record<string, unknown> = { $set: set };
  if (Object.keys(unset).length > 0) update.$unset = unset;

  try {
    const db = await getDb();
    const res = await col.riders(db).updateOne({ _id: id }, update);
    if (res.matchedCount === 0) return NextResponse.json({ error: 'Unknown rider.' }, { status: 404 });
    return NextResponse.json({ id: id.toHexString() });
  } catch (err) {
    return notConfigured(err) ?? NextResponse.json({ error: 'Could not update the rider.' }, { status: 503 });
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const denied = await gate();
  if (denied) return denied;

  const raw = new URL(req.url).searchParams.get('id') ?? '';
  if (!ObjectId.isValid(raw)) {
    return NextResponse.json({ error: 'A valid rider id is required.' }, { status: 400 });
  }
  const id = new ObjectId(raw);

  try {
    const db = await getDb();
    // Unassign this rider from any zone it ran, so those stops become "unassigned"
    // rather than pointing at a rider that no longer exists.
    await col.zones(db).updateMany({ riderId: id }, { $unset: { riderId: '' } });
    const res = await col.riders(db).deleteOne({ _id: id });
    if (res.deletedCount === 0) return NextResponse.json({ error: 'Unknown rider.' }, { status: 404 });
    return NextResponse.json({ deleted: raw });
  } catch (err) {
    return notConfigured(err) ?? NextResponse.json({ error: 'Could not delete the rider.' }, { status: 503 });
  }
}
