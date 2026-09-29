'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

export interface NavItem {
  href: string;
  label: string;
  group: 'ops' | 'crm';
}

/**
 * Admin navigation. A horizontal menu on wide screens; on a phone it collapses
 * behind a Menu button so the day's numbers are the first thing on screen.
 */
export default function AdminNav({ items, who }: { items: NavItem[]; who: string }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => (href === '/admin' ? path === '/admin' : path === href || path.startsWith(`${href}/`));
  const current = items.find(i => isActive(i.href));

  return (
    <nav className="ops-nav" aria-label="Admin">
      <div className="ops-nav-bar">
        <Link href="/admin" className="ops-brand">
          Maavuli ops
        </Link>
        <span className="ops-nav-current">{current?.label ?? ''}</span>
        <button
          type="button"
          className="ops-nav-toggle"
          aria-expanded={open}
          aria-controls="ops-nav-list"
          onClick={() => setOpen(o => !o)}
        >
          {open ? 'Close' : 'Menu'}
        </button>
      </div>
      <div id="ops-nav-list" className={`ops-nav-list${open ? ' is-open' : ''}`}>
        <ul>
          {items
            .filter(i => i.group === 'ops')
            .map(i => (
              <li key={i.href}>
                <Link href={i.href} aria-current={isActive(i.href) ? 'page' : undefined} onClick={() => setOpen(false)}>
                  {i.label}
                </Link>
              </li>
            ))}
        </ul>
        <ul className="ops-nav-crm">
          {items
            .filter(i => i.group === 'crm')
            .map(i => (
              <li key={i.href}>
                <Link href={i.href} aria-current={isActive(i.href) ? 'page' : undefined} onClick={() => setOpen(false)}>
                  {i.label}
                </Link>
              </li>
            ))}
        </ul>
        <p className="ops-who">{who}</p>
      </div>
    </nav>
  );
}
