import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/db';
import { col, type Zone } from '@/lib/models';
import { actorFor, requireStaff } from '@/lib/roles';
import { handleRouteError, ok, readJson } from '@/lib/api';
import { ctxFor } from '@/lib/clock';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { recordEvent } from '@/lib/events';
import { markRouteDirty } from '@/lib/route-plan';
import { circleToPolygon, pointsToPolygon, normalizePoint } from '@/lib/geo';
import { listZones } from '@/lib/serviceability';

/**
 * Delivery zones — the admin-configurable service area.
 *
 * GET    list every zone (active and not) — staff: owner, ops, support
 * POST   create a circle ({ name, lat, lng, radiusM, note?, riderId? }) or a polygon
 *        ({ name, points, ... }) — owner, ops
 * PATCH  { id, active?, riderId? (null clears) } — owner, ops
 * DELETE ?id=… — owner, ops
 *
 * The GeoJSON `geometry` is DERIVED here from the operator's input, never accepted
 * from the client: a reversed ring makes MongoDB match the complement of the zone
 * ("everywhere except here"), which fails OPEN.
 *
 * A change to a zone's rider or active flag moves stops between riders, so the
 * affected standing routes are marked dirty (contract §4 Routing).
 */

export const dynamic = 'force-dynamic';

const MAX_RADIUS_M = 60_000;
const MIN_RADIUS_M = 100;

function zoneJson(z: Zone) {
  return {
    id: z._id?.toHexString(),
    name: z.name,
    active: z.active,
    shape: z.shape,
    note: z.note ?? null,
    riderId: z.riderId ? z.riderId.toHexString() : null,
  };
}

export async function GET() {
  try {
    await requireStaff(['owner', 'ops', 'support']);
    const zones = await listZones();
    return ok({ zones: zones.map(zoneJson) });
  } catch (err) {
    return handleRouteError(err);
  }
}

interface PostBody {
  name?: unknown;
  lat?: unknown;
  lng?: unknown;
  radiusM?: unknown;
  points?: unknown;
  note?: unknown;
  riderId?: unknown;
}

export async function POST(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const ctx = ctxFor(req, actorFor(p, 'staff'));
    const body = await readJson<PostBody>(req);

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) throw new ValidationError('A zone name (up to 80 characters) is required.');
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : undefined;
    let riderId: ObjectId | undefined;
    if (body.riderId !== undefined && body.riderId !== null && body.riderId !== '') {
      if (typeof body.riderId !== 'string' || !ObjectId.isValid(body.riderId)) throw new ValidationError('riderId must be a valid id.');
      riderId = new ObjectId(body.riderId);
    }

    let shape: Zone['shape'];
    let geometry: Zone['geometry'];
    if (Array.isArray(body.points)) {
      const pts = [];
      for (const raw of body.points) {
        const o = raw as { lat?: unknown; lng?: unknown };
        const pt = normalizePoint(o?.lat, o?.lng);
        if (!pt) throw new ValidationError('Every polygon point needs a valid lat and lng.');
        pts.push(pt);
      }
      if (pts.length < 3) throw new ValidationError('A polygon zone needs at least 3 points.');
      shape = { kind: 'polygon', points: pts };
      geometry = pointsToPolygon(pts) as Zone['geometry'];
    } else {
      const centre = normalizePoint(body.lat, body.lng);
      if (!centre) throw new ValidationError('A valid lat and lng are required (or a points array for a polygon).');
      const radiusM = typeof body.radiusM === 'string' ? Number(body.radiusM) : body.radiusM;
      if (typeof radiusM !== 'number' || !Number.isFinite(radiusM) || radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) {
        throw new ValidationError(`radiusM must be a number between ${MIN_RADIUS_M} and ${MAX_RADIUS_M} metres.`);
      }
      shape = { kind: 'circle', centre, radiusM };
      geometry = circleToPolygon(centre, radiusM) as Zone['geometry'];
    }

    const db = await getDb();
    if (riderId && !(await col.riders(db).findOne({ _id: riderId }))) throw new NotFoundError('Unknown rider.');
    const doc: Zone = {
      name,
      active: true,
      shape,
      geometry,
      ...(note ? { note } : {}),
      ...(riderId ? { riderId } : {}),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    const res = await col.zones(db).insertOne(doc);
    await recordEvent(ctx, { entity: 'zone', entityId: res.insertedId.toHexString(), type: 'zone.created', data: { name } }, db);
    if (riderId) await markRouteDirty(riderId, 'zone created', ctx);
    return ok({ id: res.insertedId.toHexString(), name, active: true });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const p = await requireStaff(['owner', 'ops']);
    const ctx = ctxFor(req, actorFor(p, 'staff'));
    const body = await readJson<{ id?: unknown; active?: unknown; riderId?: unknown }>(req);
    if (typeof body.id !== 'string' || !ObjectId.isValid(body.id)) throw new ValidationError('A valid zone id is required.');
    const id = new ObjectId(body.id);

    const set: Record<string, unknown> = { updatedAt: ctx.now };
    const unset: Record<string, ''> = {};
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new ValidationError('active must be true or false.');
      set.active = body.active;
    }
    let newRider: ObjectId | null | undefined;
    if (body.riderId !== undefined) {
      if (body.riderId === null || body.riderId === '') {
        unset.riderId = '';
        newRider = null;
      } else if (typeof body.riderId === 'string' && ObjectId.isValid(body.riderId)) {
        newRider = new ObjectId(body.riderId);
        set.riderId = newRider;
      } else {
        throw new ValidationError('riderId must be a valid id, or null to clear.');
      }
    }
    if (body.active === undefined && body.riderId === undefined) {
      throw new ValidationError('Nothing to update: send active and/or riderId.');
    }

    const db = await getDb();
    if (newRider && !(await col.riders(db).findOne({ _id: newRider }))) throw new NotFoundError('Unknown rider.');
    const before = await col.zones(db).findOne({ _id: id });
    if (!before) throw new NotFoundError('Unknown zone.');
    const update: Record<string, unknown> = { $set: set };
    if (Object.keys(unset).length) update.$unset = unset;
    const res = await col.zones(db).updateOne({ _id: id, updatedAt: before.updatedAt }, update);
    if (res.matchedCount === 0) throw new ConflictError('The zone changed while saving — reload and try again.');

    await recordEvent(
      ctx,
      {
        entity: 'zone',
        entityId: id.toHexString(),
        type: 'zone.updated',
        data: {
          ...(body.active !== undefined ? { active: { from: before.active, to: body.active } } : {}),
          ...(newRider !== undefined
            ? { riderId: { from: before.riderId?.toHexString() ?? null, to: newRider ? newRider.toHexString() : null } }
            : {}),
        },
      },
      db,
    );
    const reason = newRider !== undefined ? 'zone handed over' : 'zone switched on/off';
    await markRouteDirty(before.riderId, reason, ctx);
    if (newRider) await markRouteDirty(newRider, reason, ctx);
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
    if (!ObjectId.isValid(raw)) throw new ValidationError('A valid zone id is required.');
    const db = await getDb();
    const zone = await col.zones(db).findOneAndDelete({ _id: new ObjectId(raw) });
    if (!zone) throw new NotFoundError('Unknown zone.');
    await recordEvent(ctx, { entity: 'zone', entityId: raw, type: 'zone.deleted', data: { name: zone.name } }, db);
    await markRouteDirty(zone.riderId, 'zone deleted', ctx);
    return ok({ deleted: raw });
  } catch (err) {
    return handleRouteError(err);
  }
}
