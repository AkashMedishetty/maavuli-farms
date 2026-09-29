/**
 * Server-side helpers for admin pages: business time + actor for the signed-in
 * staff member, and the standard error card.
 */

import { pageNow, staffActor, type OpCtx } from '@/lib/clock';
import type { StaffPrincipal } from '@/lib/admin';

export async function pageCtx(p: StaffPrincipal): Promise<OpCtx> {
  return { now: await pageNow(), actor: staffActor(p.mobile) };
}

export function LoadError({ what, message }: { what: string; message: string }) {
  return (
    <div className="ops-error" role="alert">
      <strong>Could not load {what}.</strong> {message}
    </div>
  );
}

/** Rendered when a page is reached without staff access (the layout shows the real prompt). */
export function NoAccess() {
  return null;
}
