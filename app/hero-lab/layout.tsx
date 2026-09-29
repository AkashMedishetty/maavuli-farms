import type { ReactNode } from 'react';

/**
 * The hero layout editor is a design tool (it only copies a LAYOUT object to the
 * clipboard; nothing is written server-side). The page is a client component, so
 * its noindex metadata lives here.
 */
export const metadata = { title: 'Hero lab', robots: { index: false, follow: false } };

export default function HeroLabLayout({ children }: { children: ReactNode }) {
  return children;
}
