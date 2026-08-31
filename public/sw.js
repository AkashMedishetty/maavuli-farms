/*
 * Service worker — deliberately minimal.
 *
 * A service worker is the difference between "a website" and something Android
 * will offer to install, but it is also the single easiest way to break a site
 * permanently: cache the app shell too eagerly and users get yesterday's
 * JavaScript with no way to clear it.
 *
 * So this one is narrow ON PURPOSE. It intercepts exactly two things:
 *
 *   1. Page navigations — network FIRST, falling back to the last good copy only
 *      when the network fails. A returning visitor therefore always gets current
 *      HTML; the cache exists solely so a delivery customer on a patchy morning
 *      connection sees something rather than the browser error page.
 *
 *   2. Immutable brand assets (the product renders and icons) — cache first,
 *      because they are content-addressed by name and never change in place.
 *
 * Everything else — API routes, Next.js build chunks, HMR, anything cross-origin —
 * is NOT intercepted at all. No respondWith call is made, so the browser behaves
 * exactly as if no service worker existed. That is what keeps it safe to run
 * against a dev server, and what stops a stale bundle ever being served.
 */

const VERSION = 'mv-v1';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

const OFFLINE_URL = '/';

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Best-effort: a failed precache must not abort the install, or the worker
      // never activates and the app silently loses its offline fallback.
      await cache.add(new Request(OFFLINE_URL, { cache: 'reload' })).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Drop every cache from a previous VERSION, so a bad cache is one deploy away
      // from being gone rather than sticky.
      const names = await caches.keys();
      await Promise.all(
        names.filter(n => !n.startsWith(VERSION)).map(n => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Assets safe to serve from cache first: named, immutable, non-code. */
function isImmutableAsset(url) {
  return (
    url.pathname.startsWith('/hero/') ||
    url.pathname.startsWith('/icon') ||
    url.pathname === '/apple-touch-icon.png' ||
    url.pathname === '/manifest.webmanifest'
  );
}

self.addEventListener('fetch', event => {
  const req = event.request;

  // Only ever GET, only ever same-origin. Anything else is left entirely alone.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never touch the API or the framework's own plumbing. Caching an API response
  // would show a customer someone else's stale state; caching a build chunk would
  // pin them to an old bundle.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_next/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // Keep the latest good HTML as the offline fallback.
          if (fresh.ok) {
            const cache = await caches.open(SHELL);
            cache.put(OFFLINE_URL, fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          const cache = await caches.open(SHELL);
          const cached = (await cache.match(req)) ?? (await cache.match(OFFLINE_URL));
          if (cached) return cached;
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
              '<body style="font:16px/1.6 system-ui;padding:2rem;color:#8c170e">' +
              '<h1 style="font-weight:400">You are offline.</h1>' +
              '<p>Maavuli needs a connection for this page. Your deliveries are unaffected.</p>',
            { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        }
      })(),
    );
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSETS);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      })(),
    );
  }
});
