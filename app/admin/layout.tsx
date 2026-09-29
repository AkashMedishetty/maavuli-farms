import type { Metadata } from 'next';
import Link from 'next/link';
import './admin.css';
import AdminNav, { type NavItem } from '@/components/admin/ops/AdminNav';
import { adminPrincipal, loadErrorMessage } from '@/lib/admin';
import type { Principal } from '@/lib/roles';

/**
 * Admin shell. Never indexed, never linked from the public site. The access check
 * here decides what the shell shows; every page ALSO checks (pageStaff) before it
 * loads data, because a layout is not a security boundary in the App Router.
 */
export const metadata: Metadata = {
  title: 'Admin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const ROLE_LABEL = { owner: 'Owner', ops: 'Ops', support: 'Support' } as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let p: Principal | null;
  try {
    p = await adminPrincipal();
  } catch (err) {
    return (
      <div className="ops-root">
        <main className="ops-gate">
          <h1>Admin is unavailable</h1>
          <p className="ops-error" role="alert">
            {loadErrorMessage(err)}
          </p>
        </main>
      </div>
    );
  }

  if (!p) {
    return (
      <div className="ops-root">
        <main className="ops-gate">
          <p className="ops-eyebrow">Maavuli admin</p>
          <h1>Sign in to continue</h1>
          <p>The admin console is for farm staff. Sign in with your staff mobile number.</p>
          <Link className="ops-btn ops-btn-primary" href="/account?next=/admin">
            Sign in
          </Link>
        </main>
      </div>
    );
  }

  if (!p.staffRole) {
    return (
      <div className="ops-root">
        <main className="ops-gate">
          <p className="ops-eyebrow">Maavuli admin</p>
          <h1>Not authorised</h1>
          <p>
            The number you signed in with ({p.mobile}) is not on the staff list. Ask the owner to add you, or sign in
            with a staff number.
          </p>
          <Link className="ops-btn" href="/account">
            Go to my account
          </Link>
        </main>
      </div>
    );
  }

  const items: NavItem[] = [
    { href: '/admin', label: 'Today', group: 'ops' },
    { href: '/admin/tomorrow', label: 'Tomorrow', group: 'ops' },
    { href: '/admin/exceptions', label: 'Exceptions', group: 'ops' },
    { href: '/admin/riders', label: 'Riders & zones', group: 'ops' },
    { href: '/admin/routes', label: 'Routes', group: 'ops' },
    { href: '/admin/disruptions', label: 'Disruptions', group: 'ops' },
    { href: '/admin/settings', label: 'Settings', group: 'ops' },
    { href: '/admin/customers', label: 'Customers', group: 'crm' },
    { href: '/admin/orders', label: 'Orders', group: 'crm' },
    { href: '/admin/subscriptions', label: 'Plans', group: 'crm' },
    { href: '/admin/refunds', label: 'Refunds', group: 'crm' },
    { href: '/admin/messages', label: 'Messages', group: 'crm' },
    ...(p.staffRole === 'owner' ? [{ href: '/admin/staff', label: 'Staff', group: 'crm' as const }] : []),
  ];
  const who = `${p.staffName ?? p.mobile} · ${ROLE_LABEL[p.staffRole]}`;

  return (
    <div className="ops-root">
      <AdminNav items={items} who={who} />
      <div className="ops-main">{children}</div>
    </div>
  );
}
