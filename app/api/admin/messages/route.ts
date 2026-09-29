/**
 * GET /api/admin/messages?status=&mobile=&template=&cursor=  — staff read of the
 * outbox. OWNER: B6. Access: owner, ops, support (admin reads, §7).
 *
 * Cursor pagination by _id (stable, index-backed): the response returns a
 * `nextCursor` (the last row's _id) when a full page came back; pass it as `cursor`
 * to get the next page. Page size is fixed.
 */

import { ObjectId } from 'mongodb';
import { requireStaff } from '@/lib/roles';
import { getDb } from '@/lib/db';
import { col, normalizeMobile, type MessageStatus, type OutboundMessage } from '@/lib/models';
import { ok, handleRouteError } from '@/lib/api';
import { ValidationError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

const PAGE = 50;
const STATUSES: readonly MessageStatus[] = ['queued', 'sent', 'delivered', 'read', 'failed', 'logged', 'suppressed'];

export async function GET(req: Request) {
  try {
    await requireStaff(['owner', 'ops', 'support']);
    const url = new URL(req.url);
    const q: Record<string, unknown> = {};

    const status = url.searchParams.get('status');
    if (status) {
      if (!STATUSES.includes(status as MessageStatus)) throw new ValidationError('Unknown status', [`status "${status}"`]);
      q.status = status;
    }

    const mobileParam = url.searchParams.get('mobile');
    if (mobileParam) {
      const m = normalizeMobile(mobileParam);
      if (!m) throw new ValidationError('Invalid mobile');
      q.mobile = m;
    }

    const template = url.searchParams.get('template');
    if (template) q.template = template;

    const cursor = url.searchParams.get('cursor');
    if (cursor) {
      if (!ObjectId.isValid(cursor)) throw new ValidationError('Invalid cursor');
      // _id descending, so the next page is rows with _id < cursor
      q._id = { $lt: new ObjectId(cursor) };
    }

    const db = await getDb();
    const rows = await col
      .outbox(db)
      .find(q as Partial<OutboundMessage>)
      .sort({ _id: -1 })
      .limit(PAGE)
      .toArray();

    const nextCursor = rows.length === PAGE ? rows[rows.length - 1]?._id?.toHexString() ?? null : null;
    return ok({ messages: rows, nextCursor });
  } catch (err) {
    return handleRouteError(err);
  }
}
