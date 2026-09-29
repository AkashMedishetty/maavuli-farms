import type { Metadata, Viewport } from 'next';
import './rider.css';

export const metadata: Metadata = {
  title: 'Maavuli Rider',
  manifest: '/rider.webmanifest',
  appleWebApp: { capable: true, title: 'Rider', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: '#0f1720',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RiderLayout({ children }: { children: React.ReactNode }) {
  return <div className="rider-app">{children}</div>;
}
