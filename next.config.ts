import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The whole visual language is inline SVG, so there is nothing to optimise here
  // and nothing to lazy-load: first paint is server HTML plus ~14 KB of vector.
  experimental: { optimizePackageImports: [] },
};

export default config;
