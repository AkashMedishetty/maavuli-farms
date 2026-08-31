'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Kolam from './Kolam';
import { BRAND } from '@/lib/content';

/**
 * Nav to the reference's structure: a pill group left, the brand in a tab that
 * BREAKS the top edge of the red panel upward into the white page, then links plus
 * a round icon button and a filled CTA on the right.
 *
 * That protruding tab is what proved the white border is part of the design and
 * not a mockup bezel — a bezel cannot be overlapped by page content.
 *
 * The nav lives inside the panel, so it is not sticky: the reference's nav scrolls
 * away with the panel. A sticky bar would sit outside the rounded corners and break
 * the illusion the whole layout depends on.
 */

const LEFT = [
  { href: '/', label: 'Home' },
  { href: '/our-farm', label: 'Our Farm' },
  { href: '/plans', label: 'Plans' },
] as const;

const RIGHT = [
  { href: '/account', label: 'My Deliveries' },
  { href: '/contact', label: 'Contact' },
] as const;

export default function Nav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const isOn = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

  return (
    <nav className={`vnav${open ? ' open' : ''}`}>
      <div className="vnav-group vnav-left">
        {LEFT.map(l => (
          <Link key={l.href} href={l.href} className={isOn(l.href) ? 'pill on' : 'pill'}
                onClick={() => setOpen(false)}>
            {l.label}
          </Link>
        ))}
      </div>

      {/* the tab: sits above the panel's top edge, white on the white page */}
      <Link href="/" className="vnav-brand" onClick={() => setOpen(false)}>
        <Kolam size={22} strokeWidth={6} dots={false} />
        <span>{BRAND.name}</span>
      </Link>

      <div className="vnav-group vnav-right">
        {RIGHT.map(l => (
          <Link key={l.href} href={l.href} className={isOn(l.href) ? 'pill on' : 'pill'}
                onClick={() => setOpen(false)}>
            {l.label}
          </Link>
        ))}
        <Link href="/subscribe" className="vnav-cta" onClick={() => setOpen(false)}>
          Subscribe <span aria-hidden />
        </Link>
      </div>

      <button className="vnav-burger" aria-expanded={open} aria-controls="vnav-sheet"
              onClick={() => setOpen(v => !v)}>
        {open ? 'Close' : 'Menu'}
      </button>

      <div className="vnav-sheet" id="vnav-sheet">
        {[...LEFT, ...RIGHT].map(l => (
          <Link key={l.href} href={l.href} onClick={() => setOpen(false)}>{l.label}</Link>
        ))}
        <Link href="/subscribe" className="vnav-cta" onClick={() => setOpen(false)}>
          Subscribe <span aria-hidden />
        </Link>
      </div>
    </nav>
  );
}
