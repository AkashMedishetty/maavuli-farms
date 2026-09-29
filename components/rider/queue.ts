'use client';

/**
 * Offline action queue for the rider app.
 *
 * A rider works through streets with patchy signal. Every outcome (delivered /
 * couldn't-deliver) is written to IndexedDB FIRST, then flushed to the server when
 * a connection is available, with exponential backoff. A photo blob rides along in
 * the same record so a delivery captured underground still syncs when the rider
 * surfaces. The last good `today` snapshot is cached so an offline reload still
 * shows the round.
 *
 * Server idempotency (rider_actions.actionId) makes a retry safe: the same actionId
 * is a no-op on the server, so flushing twice cannot double-apply.
 */

const DB_NAME = 'maavuli-rider';
const DB_VERSION = 1;
const STORE_QUEUE = 'queue';
const STORE_CACHE = 'cache';

export interface QueuedAction {
  actionId: string;
  deliveryId: string;
  type: 'delivered' | 'not_delivered';
  note?: string;
  reason?: string;
  proof?: { lat?: number; lng?: number; accuracyM?: number; capturedAt?: string };
  /** the compressed photo, if any, waiting to upload before the action is sent */
  photoBlob?: Blob;
  photoContentType?: string;
  /** set once the photo has uploaded and we have its storage key */
  photoKey?: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'actionId' });
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function enqueueAction(a: QueuedAction): Promise<void> {
  await tx(STORE_QUEUE, 'readwrite', s => s.put(a));
}

export async function allQueued(): Promise<QueuedAction[]> {
  const rows = await tx<QueuedAction[]>(STORE_QUEUE, 'readonly', s => s.getAll() as IDBRequest<QueuedAction[]>);
  return rows.sort((x, y) => x.createdAt - y.createdAt);
}

export async function removeQueued(actionId: string): Promise<void> {
  await tx(STORE_QUEUE, 'readwrite', s => s.delete(actionId));
}

export async function updateQueued(a: QueuedAction): Promise<void> {
  await tx(STORE_QUEUE, 'readwrite', s => s.put(a));
}

export async function queueCount(): Promise<number> {
  return tx<number>(STORE_QUEUE, 'readonly', s => s.count());
}

export async function cacheToday(snapshot: unknown): Promise<void> {
  await tx(STORE_CACHE, 'readwrite', s => s.put({ key: 'today', snapshot, at: Date.now() }));
}

export async function readCachedToday(): Promise<unknown | null> {
  try {
    const row = await tx<{ snapshot: unknown } | undefined>(
      STORE_CACHE,
      'readonly',
      s => s.get('today') as IDBRequest<{ snapshot: unknown } | undefined>,
    );
    return row?.snapshot ?? null;
  } catch {
    return null;
  }
}

/** Exponential backoff with a ceiling, from the attempt count. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
}

export function newActionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `a_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
