import type { MetadataRoute } from 'next';

/**
 * robots.txt. Search engines may index the public site ONLY on its real domain:
 * until NEXT_PUBLIC_SITE_URL points at one, everything is disallowed, so the
 * staging address (…vercel.app) never ends up in search results competing with the
 * real site. Private surfaces are disallowed either way.
 */
export default function robots(): MetadataRoute.Robots {
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? '').trim().replace(/\/$/, '');
  const live = /^https:\/\//.test(site) && !/\.vercel\.app$/i.test(new URL(site).hostname);
  if (!live) return { rules: [{ userAgent: '*', disallow: '/' }] };
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/', '/admin', '/rider', '/account', '/subscribe', '/hero-lab', '/concept-a'] }],
    sitemap: `${site}/sitemap.xml`,
  };
}
