import { ctxFor } from '@/lib/clock';
import { actorFor, requireRider } from '@/lib/roles';
import { handleRouteError, jsonError, ok } from '@/lib/api';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { getDb } from '@/lib/db';
import { col } from '@/lib/models';
import {
  clientUploadToken,
  photoKeyFor,
  putObject,
  recordPhoto,
  storageDriver,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED = new Set(['image/jpeg', 'image/webp']);

/**
 * POST /api/rider/photos — get a place to store a doorstep photo for one of the
 * rider's own deliveries.
 *
 *  · local driver: send the raw image bytes as the body with
 *    Content-Type: image/jpeg|webp and ?deliveryId=<id>. Returns { key }.
 *  · vercel-blob driver: send JSON { deliveryId, contentType } and receive a
 *    client-upload token the phone uses to PUT straight to the private store.
 *    Returns { key, token }.
 */
export async function POST(req: Request) {
  try {
    const p = await requireRider();
    const ctx = ctxFor(req, actorFor(p, 'rider'));
    const db = await getDb();
    const { ObjectId } = await import('mongodb');

    const url = new URL(req.url);
    const contentType = (req.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    const driver = storageDriver();

    // Resolve the target delivery: query param for the raw path, JSON body for blob.
    let deliveryIdRaw: string | null = url.searchParams.get('deliveryId');
    let wantContentType = contentType;

    if (driver === 'vercel-blob' && contentType === 'application/json') {
      const body = (await req.json()) as { deliveryId?: unknown; contentType?: unknown };
      deliveryIdRaw = typeof body.deliveryId === 'string' ? body.deliveryId : deliveryIdRaw;
      wantContentType = typeof body.contentType === 'string' ? body.contentType : 'image/jpeg';
    }

    if (!deliveryIdRaw) throw new ValidationError('deliveryId is required');
    let deliveryId;
    try {
      deliveryId = new ObjectId(deliveryIdRaw);
    } catch {
      throw new ValidationError('invalid deliveryId');
    }

    const delivery = await col.deliveries(db).findOne({ _id: deliveryId, riderId: p.riderId });
    if (!delivery) throw new NotFoundError('Delivery not found on your run');

    if (!ALLOWED.has(wantContentType)) {
      throw new ValidationError('Photo must be image/jpeg or image/webp');
    }

    const key = photoKeyFor(delivery.date, deliveryIdRaw, wantContentType);

    if (driver === 'vercel-blob') {
      const token = await clientUploadToken(key, wantContentType);
      // Pre-index the photo; the phone uploads under this exact key.
      await recordPhoto(
        { key, deliveryId, riderId: p.riderId, mobile: delivery.mobile, date: delivery.date, contentType: wantContentType },
        ctx,
      );
      return ok({ driver, key, token });
    }

    // Local driver: the body IS the image.
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.byteLength === 0) throw new ValidationError('Empty body — send the image bytes');
    if (buf.byteLength > MAX_BYTES) return jsonError(413, 'Photo too large (max 2 MB)');

    const stored = await putObject(key, new Uint8Array(buf), wantContentType);
    await recordPhoto(
      {
        key: stored.key,
        deliveryId,
        riderId: p.riderId,
        mobile: delivery.mobile,
        date: delivery.date,
        bytes: stored.bytes,
        contentType: wantContentType,
      },
      ctx,
    );
    return ok({ driver, key: stored.key, bytes: stored.bytes });
  } catch (err) {
    return handleRouteError(err);
  }
}
