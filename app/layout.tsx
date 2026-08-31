import type { Metadata, Viewport } from 'next';
import KolamDefs from '@/components/KolamDefs';
import PourLoader from '@/components/PourLoader';
import { BRAND } from '@/lib/content';
import './globals.css';

/**
 * No `metadataBase` and no canonical host: NEXT_PUBLIC_SITE_URL is not set yet and
 * a guessed hostname is a fabricated fact that search engines act on.
 */
export const metadata: Metadata = {
  title: {
    default: `${BRAND.fullName} — ${BRAND.tagline}`,
    template: `%s · ${BRAND.fullName}`,
  },
  description:
    'Farm-fresh cow and buffalo milk, collected and bottled at the farm and delivered to your ' +
    'doorstep every morning. No processing, no middlemen.',
  applicationName: BRAND.fullName,
  manifest: '/manifest.webmanifest',
  // iOS does not read the manifest for the home-screen icon, so the PNG is declared
  // here — without it an installed app falls back to a screenshot of the page.
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  appleWebApp: { capable: true, title: BRAND.name, statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: true, address: false },
};

export const viewport: Viewport = {
  themeColor: '#8c170e',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

/**
 * Runs BEFORE first paint. sessionStorage is client-only, so without this the
 * loader would flash on every navigation within a session — the overlay ships in
 * the HTML and this is what hides it again in time.
 */
// Pre-paint guard. Only the capture/test scripts set mv-skip-loader; a real visit
// never has it, so the loader is no longer suppressed on a reload the way the old
// 'mv-loaded' key suppressed it.
/*
 * Register the service worker after load, so it never competes with first paint.
 * Registration is wrapped in a try and deliberately silent on failure: an
 * unavailable worker (private mode, insecure origin, unsupported browser) must
 * degrade to a plain website, not surface an error to a customer.
 */
const SW_REGISTER =
  `if('serviceWorker' in navigator){addEventListener('load',function(){` +
  `navigator.serviceWorker.register('/sw.js').catch(function(){})})}`;

const NO_FLASH = `try{if(sessionStorage.getItem('mv-skip-loader'))document.documentElement.classList.add('loaded')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
        <script dangerouslySetInnerHTML={{ __html: SW_REGISTER }} />
      </head>
      <body>
        <KolamDefs />
        <PourLoader />
        {children}
      </body>
    </html>
  );
}
