import type { Metadata } from 'next';

/**
 * The admin panel must never be indexed and never advertised. There is no link to
 * it in the public nav or footer by design — it is reached by URL only, and the
 * server-side allowlist check is the real gate (this metadata is defence in depth,
 * not the security boundary).
 */
export const metadata: Metadata = {
  title: 'Admin',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
