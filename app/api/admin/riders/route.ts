import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, normalizeMobile, type Rider } from '@/lib/models';
import { actorFor, requireStaff } from '@/lib/roles';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { recordEvent } from '@/lib/events';
import { markRouteDirty } from '@/lib/route-plan';
import { normalizePoint } from '@/lib/geo';

/**
 * Delivery riders — the people a zone's stops are assigned to.
 *
 * GET    list every rider — staff: owner, ops, support
 * POST   create  { name, phone?, lat?, lng?, note? } — owner, ops
 * PATCH  { id, active? | name? | phone? ('' clears) | lat?,lng? | note? | maxStops? | maxLitres? ('' clears) } — owner, ops
 * DELETE ?id=… — owner, ops. Refused while the rider holds a live run; their zones
 *        become unassigned.
 *
 * `phone` is the rider's LOGIN: they sign in at /rider with an OTP sent to this
 * number (lib/roles matches riders.phone to the session mobile). It is unique.
 */

export const dynamic = 'force-dynamic';

function riderJson(r: Rider) {
  return {
    id: r._id?.toHexString(),
    name: r.name,
    phone: r.phone ?? null,
    active: r.active,
    startLocation: r.startLocation ?? null,
    capacity: r.capacity ?? null,
    note: r.note ?? null,
  };
}

/**
 * A capacity limit from the request: undefined = leave as is, null/'' = clear (no
 * limit), a number = set. Stops are whole doors; litres may be halves.
 */
function readLimit(v: unknown, label: string, max: number, whole: boolean): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > max || (whole && !Number.isInteger(n))) {
    throw new ValidationError(`${label} must be ${whole ? 'a whole number' : 'a number'} between 1 and ${max}, or empty for no limit.`);
  }
  return n;
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

const PHONE_TAKEN = 'Another rider already signs in with that phone number.';

export async function GET() {
  try {
    await requireStaff(['owner', 'ops', 'support']);
    const db = await getDb();
    const riders = await col.riders(db).find({}).sort({ name: 1 }).toArray();
    return ok({ riders: riders.map(riderJson) });
  } catch (err) {
    return handleRouteError(err);
  }
}

interface Body {
  id?: unknown;
  name?: unknown;
  phone?: unknown;
  lat?: unknown;
  lng?: unknown;
  note?: unknown;
  active?: unknown;
  maxStops?: unknown;
  maxLitres?: unknown;
}

function readName(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > 80) throw new ValidationError('Rider name must be 1–80 characters.');
  return name;
}

export async function POST(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const ctx = ctxFor(req, actorFor(p, 'staff'));
    const body = await readJson<Body>(req);
    const name = readName(body.name ?? '');

    let phone: string | undefined;
    if (typeof body.phone === 'string' && body.phone.trim()) {
      const norm = normalizeMobile(body.phone);
      if (!norm) throw new ValidationError('phone must be a valid 10-digit Indian mobile.');
      phone = norm;
    }
    let startLocation: { lat: number; lng: number } | undefined;
    if (body.lat != null && body.lng != null && body.lat !== '' && body.lng !== '') {
      const pt = normalizePoint(body.lat, body.lng);
      if (!pt) throw new ValidationError('Start point lat/lng are invalid.');
      startLocation = { lat: pt.lat, lng: pt.lng };
    }
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : undefined;

    const db = await getDb();
    const doc: Rider = {
      name: name!,
      active: true,
      ...(phone ? { phone } : {}),
      ...(startLocation ? { startLocation } : {}),
      ...(note ? { note } : {}),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    let insertedId: ObjectId;
    try {
      insertedId = (await col.riders(db).insertOne(doc)).insertedId;
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError(PHONE_TAKEN);
      throw err;
    }
    await recordEvent(ctx, { entity: 'rider', entityId: insertedId.toHexString(), type: 'rider.created', data: { name } }, db);
    return ok({ id: insertedId.toHexString(), name, active: true });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const ctx = ctxFor(req, actorFor(p, 'staff'));
    const body = await readJson<Body>(req);
    if (typeof body.id !== 'string' || !ObjectId.isValid(body.id)) throw new ValidationError('A valid rider id is required.');
    const id = new ObjectId(body.id);

    const set: Record<string, unknown> = { updatedAt: ctx.now };
    const unset: Record<string, ''> = {};
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new ValidationError('active must be true or false.');
      set.active = body.active;
    }
    const name = readName(body.name);
    if (name) set.name = name;
    if (body.phone !== undefined) {
      if (typeof body.phone !== 'string') throw new ValidationError('phone must be a string.');
      if (body.phone.trim() === '') unset.phone = '';
      else {
        const norm = normalizeMobile(body.phone);
        if (!norm) throw new ValidationError('phone must be a valid 10-digit Indian mobile.');
        set.phone = norm;
      }
    }
    let moved = false;
    if (body.lat !== undefined || body.lng !== undefined) {
      if ((body.lat === null || body.lat === '') && (body.lng === null || body.lng === '')) {
        unset.startLocation = '';
      } else {
        const pt = normalizePoint(body.lat, body.lng);
        if (!pt) throw new ValidationError('Start point lat/lng are invalid.');
        set.startLocation = { lat: pt.lat, lng: pt.lng };
      }
      moved = true;
    }
    if (body.note !== undefined) {
      if (typeof body.note !== 'string') throw new ValidationError('note must be a string.');
      if (body.note.trim() === '') unset.note = '';
      else set.note = body.note.trim().slice(0, 300);
    }
    // capacity — used by the daily lock's load balancing (lib/balance)
    const maxStops = readLimit(body.maxStops, 'Max stops', 200, true);
    if (maxStops === null) unset['capacity.maxStops'] = '';
    else if (maxStops !== undefined) set['capacity.maxStops'] = maxStops;
    const maxLitres = readLimit(body.maxLitres, 'Max litres', 500, false);
    if (maxLitres === null) unset['capacity.maxLitres'] = '';
    else if (maxLitres !== undefined) set['capacity.maxLitres'] = maxLitres;

    const db = await getDb();
    const update: Record<string, unknown> = { $set: set };
    if (Object.keys(unset).length) update.$unset = unset;
    let matched: number;
    try {
      matched = (await col.riders(db).updateOne({ _id: id }, update)).matchedCount;
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError(PHONE_TAKEN);
      throw err;
    }
    if (matched === 0) throw new NotFoundError('Unknown rider.');
    await recordEvent(
      ctx,
      {
        entity: 'rider',
        entityId: id.toHexString(),
        type: 'rider.updated',
        data: { fields: [...Object.keys(set).filter(k => k !== 'updatedAt'), ...Object.keys(unset)] },
      },
      db,
    );
    if (moved) await markRouteDirty(id, 'start point changed', ctx);
    return ok({ id: id.toHexString() });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const ctx = ctxFor(req, actorFor(p, 'staff'));
    const raw = new URL(req.url).searchParams.get('id') ?? '';
    if (!ObjectId.isValid(raw)) throw new ValidationError('A valid rider id is required.');
    const id = new ObjectId(raw);
    const db = await getDb();

    // A rider with a frozen, not-yet-closed run cannot vanish: their stops would lose
    // their rider mid-morning. Hand the run to a cover rider first.
    const live = await col.riderRuns(db).countDocuments({ riderId: id, status: { $ne: 'closed' } }, { limit: 1 });
    if (live) throw new ConflictError('This rider has a run that is not closed yet. Hand it to a cover rider first, or turn the rider off.');

    await col.zones(db).updateMany({ riderId: id }, { $unset: { riderId: '' }, $set: { updatedAt: ctx.now } });
    const res = await col.riders(db).deleteOne({ _id: id });
    if (res.deletedCount === 0) throw new NotFoundError('Unknown rider.');
    await recordEvent(ctx, { entity: 'rider', entityId: raw, type: 'rider.deleted' }, db);
    return ok({ deleted: raw });
  } catch (err) {
    return handleRouteError(err);
  }
}
