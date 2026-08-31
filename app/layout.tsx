import type { Metadata, Viewport } from 'next';
import Nav from '@/components/Nav';
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
const NO_FLASH = `try{if(sessionStorage.getItem('mv-loaded'))document.documentElement.classList.add('loaded')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body>
        <KolamDefs />
        <PourLoader />
        <Nav />
        {children}
      </body>
    </html>
  );
}
