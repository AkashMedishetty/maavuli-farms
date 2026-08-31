import { MongoClient, type Db } from 'mongodb';
import { mongoConfig } from './env';

/**
 * The ONE Mongo connection. Every route uses `getDb()`; nothing else constructs a
 * MongoClient.
 *
 * The global cache is not laziness — Next's dev server re-evaluates modules on
 * every edit, and a fresh MongoClient per reload exhausts the connection pool
 * within a few minutes of normal work.
 *
 * Connecting is deliberately lazy: `next build` prerenders pages and must not need
 * a reachable database.
 */

declare global {
  // eslint-disable-next-line no-var
  var __maavuliMongo: { client: MongoClient; db: Db } | undefined;
}

export class NotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`Database not configured — missing: ${missing.join(', ')}`);
    this.name = 'NotConfiguredError';
  }
}

export async function getDb(): Promise<Db> {
  if (global.__maavuliMongo) return global.__maavuliMongo.db;

  const cfg = mongoConfig();
  if (!cfg.ok) throw new NotConfiguredError(cfg.missing);

  const client = new MongoClient(cfg.value.MONGODB_URI, {
    // a hung request is worse than a fast failure on a checkout path
    serverSelectionTimeoutMS: 5000,
    retryWrites: true,
  });
  await client.connect();
  const db = client.db(cfg.value.MONGODB_DB);
  global.__maavuliMongo = { client, db };
  return db;
}

/** True when the database is reachable — for health checks, never for control flow. */
export async function dbReachable(): Promise<boolean> {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
