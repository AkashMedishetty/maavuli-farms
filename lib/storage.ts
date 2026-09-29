/**
 * Photo storage behind one seam. OWNER: B5 (rider app). Keep the signatures.
 *
 * STORAGE_DRIVER=vercel-blob (production): a PRIVATE Vercel Blob store
 * (BLOB_READ_WRITE_TOKEN), client uploads straight from the rider's phone.
 * STORAGE_DRIVER=local (development / e2e): files under .data/uploads (gitignored).
 * Unset in production → ServiceNotConfiguredError (503) naming the variable.
 * Photos are only ever served through /api/photos/[...key], which checks access.
 */

import type { OpCtx } from './clock';

export type StorageDriver = 'vercel-blob' | 'local';

export function storageDriver(): StorageDriver {
  throw new Error('not implemented: storageDriver (owner B5)');
}

/** Store bytes under `key` (server-side path, used by the local driver and tests). */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<{ key: string; bytes: number }> {
  void key;
  void body;
  void contentType;
  throw new Error('not implemented: putObject (owner B5)');
}

export async function getObject(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
  void key;
  throw new Error('not implemented: getObject (owner B5)');
}

export async function deleteObject(key: string): Promise<void> {
  void key;
  throw new Error('not implemented: deleteObject (owner B5)');
}

/** Tick step: delete photos older than photoRetentionDays (bytes + PhotoRecord.deletedAt). */
export async function purgeOldPhotos(ctx: OpCtx): Promise<{ deleted: number }> {
  void ctx;
  throw new Error('not implemented: purgeOldPhotos (owner B5)');
}
