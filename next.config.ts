import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The whole visual language is inline SVG, so there is nothing to optimise here
  // and nothing to lazy-load: first paint is server HTML plus ~14 KB of vector.
  images: {
    // AVIF first, WebP fallback. The source PNGs are ~4.8 MB total and are
    // never served as-is; the optimiser emits per-breakpoint srcsets.
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [420, 640, 828, 1080, 1400],
  },
  experimental: { optimizePackageImports: [] },
  /*
   * Baseline security headers on every response (Vercel adds HSTS itself).
   *  · nosniff — a delivery photo or upload is never reinterpreted as script;
   *  · SAMEORIGIN — the site (account, admin, rider) cannot be framed by another
   *    origin for clickjacking. Razorpay's checkout frames ITSELF inside our page,
   *    which this does not affect;
   *  · Referrer-Policy — full URLs (which can carry an order or plan id) are not
   *    sent to other sites;
   *  · Permissions-Policy — camera and location only for our own pages (the rider's
   *    delivery photo, "use my location" at sign-up); microphone and the rest off.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self), microphone=(), payment=(self "https://checkout.razorpay.com" "https://api.razorpay.com")' },
        ],
      },
    ];
  },
};

export default config;
