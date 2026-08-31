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
};

export default config;
