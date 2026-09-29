/**
 * Photo storage behind one seam. OWNER: B5 (rider app).
 *
 * STORAGE_DRIVER=vercel-blob (production): a PRIVATE Vercel Blob store
 * (BLOB_READ_WRITE_TOKEN), client uploads straight from the rider's phone.
 * STORAGE_DRIVER=local (development / e2e): files under .data/uploads (gitignored).
 * Unset in production → ServiceNotConfiguredError (503) naming the variable.
 * Photos are only ever served through /api/photos/[...key], which checks access.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Db, ObjectId } from 'mongodb';
import { col, type MilkKind } from './models';
import type { OpCtx } from './clock';
import { getDb } from './db';
import { requireEnv } from './env';
import { recordEvent } from './events';
import { ServiceNotConfiguredError } from './errors';

export type StorageDriver = 'vercel-blob' | 'local';

/** Where local files live (gitignored). Absolute, rooted at the working directory. */
const LOCAL_ROOT = path.join(process.cwd(), '.data', 'uploads');

const isProd = () => process.env.NODE_ENV === 'production';

/**
 * The active driver. Explicit STORAGE_DRIVER wins. With none set: 'local' outside
 * production (the documented local fallback), and in production a missing driver is
 * a configuration error, not a silent no-op.
 */
export function storageDriver(): StorageDriver {
  const raw = (process.env.STORAGE_DRIVER ?? '').trim().toLowerCase();
  if (raw === 'vercel-blob' || raw === 'local') return raw;
  if (raw !== '') {
    throw new ServiceNotConfiguredError('Photo storage', [`STORAGE_DRIVER (got "${raw}", expected vercel-blob|local)`]);
  }
  if (isProd()) throw new ServiceNotConfiguredError('Photo storage', ['STORAGE_DRIVER', 'BLOB_READ_WRITE_TOKEN']);
  return 'local';
}

function blobToken(): string {
  const raw = (process.env.BLOB_READ_WRITE_TOKEN ?? '').trim();
  if (!raw) throw new ServiceNotConfiguredError('Vercel Blob', ['BLOB_READ_WRITE_TOKEN']);
  return raw;
}

/** Storage key for a doorstep photo: photos/<date>/<deliveryId>-<random>.<ext>. */
export function photoKeyFor(date: string, deliveryId: string, contentType = 'image/jpeg'): string {
  const ext = contentType === 'image/webp' ? 'webp' : 'jpg';
  const rand = randomBytes(6).toString('hex');
  return `photos/${date}/${deliveryId}-${rand}.${ext}`;
}

/* ------------------------------------------------------------------ objects -- */

/** Store bytes under `key` (used by the local driver and tests, and the local upload route). */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<{ key: string; bytes: number }> {
  const driver = storageDriver();
  if (driver === 'vercel-blob') {
    const { put } = await import('@vercel/blob');
    const res = await put(key, Buffer.from(body), {
      access: 'public', // "public" here is the Blob access mode; the STORE is private and
      // the URL is unguessable — but we never hand the URL out. Reads go through
      // /api/photos, so effective access is authorised-only regardless.
      contentType,
      token: blobToken(),
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    void res;
    return { key, bytes: body.byteLength };
  }
  const abs = path.join(LOCAL_ROOT, key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
  return { key, bytes: body.byteLength };
}

export async function getObject(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
  const driver = storageDriver();
  if (driver === 'vercel-blob') {
    const { get } = await import('@vercel/blob');
    const res = await get(key, { access: 'private', token: blobToken() });
    if (!res || res.statusCode !== 200) return null;
    const buf = Buffer.from(await new Response(res.stream).arrayBuffer());
    return { body: new Uint8Array(buf), contentType: res.blob.contentType ?? 'application/octet-stream' };
  }
  const abs = path.join(LOCAL_ROOT, key);
  try {
    const body = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const contentType = ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { body: new Uint8Array(body), contentType };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string): Promise<void> {
  const driver = storageDriver();
  if (driver === 'vercel-blob') {
    const { del } = await import('@vercel/blob');
    await del(key, { token: blobToken() });
    return;
  }
  const abs = path.join(LOCAL_ROOT, key);
  await fs.rm(abs, { force: true });
}

/* ---------------------------------------------------- client-upload tokens -- */

/**
 * A client-upload token so the rider's phone can PUT the photo straight to the
 * private Blob store (vercel-blob driver only). The token is scoped to one pathname
 * and one content type, and expires quickly. Returns null on the local driver,
 * where the phone posts the raw bytes to /api/rider/photos instead.
 */
export async function clientUploadToken(key: string, contentType: string): Promise<string | null> {
  if (storageDriver() !== 'vercel-blob') return null;
  const { generateClientTokenFromReadWriteToken } = await import('@vercel/blob/client');
  return generateClientTokenFromReadWriteToken({
    pathname: key,
    token: blobToken(),
    allowedContentTypes: [contentType],
    maximumSizeInBytes: 2 * 1024 * 1024, // 2 MB — a compressed doorstep photo is ~150 KB
    validUntil: Date.now() + 10 * 60 * 1000,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

/* ------------------------------------------------------------ PhotoRecords -- */

export interface RecordPhotoInput {
  key: string;
  deliveryId?: ObjectId;
  riderId?: ObjectId;
  mobile?: string;
  date?: string;
  kind?: MilkKind;
  bytes?: number;
  contentType?: string;
}

/** Index a stored photo. Upsert on the unique key so a client-upload callback + a
 *  server put of the same key do not create two rows. */
export async function recordPhoto(input: RecordPhotoInput, ctx: OpCtx): Promise<void> {
  const db = await getDb();
  await col.photos(db).updateOne(
    { key: input.key },
    {
      $setOnInsert: { key: input.key, createdAt: ctx.now },
      $set: {
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
        ...(input.riderId ? { riderId: input.riderId } : {}),
        ...(input.mobile ? { mobile: input.mobile } : {}),
        ...(input.date ? { date: input.date } : {}),
        ...(typeof input.bytes === 'number' ? { bytes: input.bytes } : {}),
        ...(input.contentType ? { contentType: input.contentType } : {}),
      },
    },
    { upsert: true },
  );
}

/** Look up a photo's metadata by key (used by the serving route for access checks). */
export async function photoRecord(db: Db, key: string) {
  return col.photos(db).findOne({ key });
}

/**
 * Tick step: delete photos older than photoRetentionDays (bytes + mark the record
 * deletedAt so the index row stays as an audit stub).
 */
export async function purgeOldPhotos(ctx: OpCtx): Promise<{ deleted: number }> {
  const db = await getDb();
  const { getOpsSettings } = await import('./settings');
  const settings = await getOpsSettings(db);
  const cutoff = new Date(ctx.now.getTime() - settings.photoRetentionDays * 24 * 3600 * 1000);

  const stale = await col
    .photos(db)
    .find({ createdAt: { $lt: cutoff }, deletedAt: { $exists: false } })
    .toArray();

  let deleted = 0;
  for (const rec of stale) {
    try {
      await deleteObject(rec.key);
    } catch {
      // A blob that is already gone is fine; keep going and still mark the record.
    }
    await col.photos(db).updateOne({ _id: rec._id }, { $set: { deletedAt: ctx.now } });
    deleted++;
  }
  if (deleted) {
    await recordEvent(ctx, { entity: 'day', entityId: 'photo-purge', type: 'photo.purged', data: { deleted } }, db);
  }
  return { deleted };
}

/* ----------------------------------------------------------- signed URLs --- */

/**
 * A short-lived signed URL for a photo, absolute so a WhatsApp provider can fetch
 * it. HMAC(key + "." + expiry) with SESSION_SECRET; verified by the serving route.
 * The URL points at /api/photos/signed/<token>, which does NOT require a session —
 * possession of the signature is the authorisation, so the TTL is kept short.
 */
export async function signedPhotoUrl(key: string, ttlSec: number): Promise<string> {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? '').trim().replace(/\/$/, '');
  if (!base) throw new ServiceNotConfiguredError('Signed photo URLs', ['NEXT_PUBLIC_SITE_URL']);
  const expiry = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSec));
  const sig = signPhotoToken(key, expiry);
  const token = Buffer.from(`${key}.${expiry}.${sig}`, 'utf8').toString('base64url');
  return `${base}/api/photos/signed/${token}`;
}

function signPhotoToken(key: string, expiry: number): string {
  const secret = requireEnv('SESSION_SECRET');
  return createHmac('sha256', secret).update(`${key}.${expiry}`).digest('hex');
}

/** Verify a signed-photo token. Returns the key when valid and unexpired, else null. */
export function verifySignedPhotoToken(token: string, nowMs = Date.now()): string | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // key may itself contain dots (the extension), so split from the RIGHT: last two
  // fields are expiry and signature, everything before is the key.
  const lastDot = decoded.lastIndexOf('.');
  if (lastDot < 0) return null;
  const sig = decoded.slice(lastDot + 1);
  const rest = decoded.slice(0, lastDot);
  const expDot = rest.lastIndexOf('.');
  if (expDot < 0) return null;
  const expiry = Number(rest.slice(expDot + 1));
  const key = rest.slice(0, expDot);
  if (!key || !Number.isFinite(expiry)) return null;
  if (expiry * 1000 < nowMs) return null;

  const expected = signPhotoToken(key, expiry);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch {
    return null;
  }
  return key;
}
