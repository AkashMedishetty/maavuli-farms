import type { MetadataRoute } from 'next';

/** The public pages, on the real domain only (empty until NEXT_PUBLIC_SITE_URL is set). */
export default function sitemap(): MetadataRoute.Sitemap {
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? '').trim().replace(/\/$/, '');
  if (!/^https:\/\//.test(site)) return [];
  const pages = ['', '/plans', '/our-farm', '/contact', '/legal/terms', '/legal/privacy', '/legal/refunds', '/legal/shipping'];
  return pages.map(p => ({ url: `${site}${p}`, changeFrequency: p === '' ? 'weekly' : 'monthly', priority: p === '' ? 1 : 0.6 }));
}
