'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Kolam from './Kolam';
import { BRAND } from '@/lib/content';

const LINKS = [
  { href: '/our-farm', label: 'Our Farm' },
  { href: '/plans', label: 'Plans & Pricing' },
  { href: '/account', label: 'My Deliveries' },
  { href: '/contact', label: 'Contact' },
] as const;

export default function Nav() {
  const [open, setOpen] = useState(false);
  const [lifted, setLifted] = useState(false);

  useEffect(() => {
    const onScroll = () => setLifted(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // a menu that traps you is worse than no menu: close on Escape and on route intent
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <nav className={`nav${lifted ? ' lifted' : ''}${open ? ' open' : ''}`}>
      <Link href="/" className="nav-brand" onClick={() => setOpen(false)}>
        <Kolam size={34} strokeWidth={7} dots={false} />
        <span>{BRAND.name}</span>
      </Link>

      <button
        className="nav-toggle"
        aria-expanded={open}
        aria-controls="nav-links"
        onClick={() => setOpen(v => !v)}
      >
        {open ? 'Close' : 'Menu'}
      </button>

      <div className="nav-links" id="nav-links">
        {LINKS.map(l => (
          <Link key={l.href} href={l.href} onClick={() => setOpen(false)}>
            {l.label}
          </Link>
        ))}
        <Link className="cta nav-cta" href="/subscribe" onClick={() => setOpen(false)}>
          Subscribe
        </Link>
      </div>
    </nav>
  );
}
