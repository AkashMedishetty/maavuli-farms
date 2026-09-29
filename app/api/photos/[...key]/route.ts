import { getPrincipal } from '@/lib/roles';
import { getDb } from '@/lib/db';
import { istYMD } from '@/lib/cutoff';
import { getObject, photoRecord } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * GET /api/photos/<key...> — serve a private doorstep photo, access-controlled.
 *
 * Allowed:
 *  · any staff member (owner/ops/support)
 *  · the rider who took it, but only on the same IST day (a work tool, not an archive)
 *  · the customer the delivery belongs to
 * Everyone else gets 404 — the same answer as a non-existent key, so the endpoint
 * does not confirm a photo exists to someone not allowed to see it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }): Promise<Response> {
  try {
    const { key: parts } = await params;
    const key = (parts ?? []).map(decodeURIComponent).join('/');
    if (!key || !key.startsWith('photos/')) return notFound();

    const principal = await getPrincipal();
    if (!principal) return notFound();

    const db = await getDb();
    const rec = await photoRecord(db, key);
    if (!rec || rec.deletedAt) return notFound();

    const isStaff = principal.staffRole !== null;
    const isOwningRider =
      principal.riderId !== null &&
      rec.riderId !== undefined &&
      String(principal.riderId) === String(rec.riderId) &&
      rec.date === istYMD(new Date());
    const isCustomer = rec.mobile !== undefined && rec.mobile === principal.mobile;

    if (!isStaff && !isOwningRider && !isCustomer) return notFound();

    const obj = await getObject(key);
    if (!obj) return notFound();

    return new Response(Buffer.from(obj.body), {
      status: 200,
      headers: {
        'content-type': obj.contentType,
        'cache-control': 'private, no-store',
      },
    });
  } catch {
    return notFound();
  }
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}
