import { getObject, verifySignedPhotoToken } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * GET /api/photos/signed/<token> — serve a photo to anyone holding a valid HMAC
 * signature (a WhatsApp provider fetching the delivered_today media header). No
 * session: possession of the unexpired signature IS the authorisation, which is why
 * signedPhotoUrl mints short-lived tokens. An expired or tampered token is a 404.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    const { token } = await params;
    const key = verifySignedPhotoToken(token);
    if (!key) return notFound();

    const obj = await getObject(key);
    if (!obj) return notFound();

    return new Response(Buffer.from(obj.body), {
      status: 200,
      headers: {
        'content-type': obj.contentType,
        // Providers may re-fetch; a signed URL is safe to cache for its short life.
        'cache-control': 'private, max-age=300',
      },
    });
  } catch {
    return notFound();
  }
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}
