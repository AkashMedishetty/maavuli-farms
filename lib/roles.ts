/**
 * Who is calling: customer, staff (owner / ops / support) and/or rider.
 *
 * Roles are RESOLVED PER REQUEST from the session's mobile, never stored on the
 * session or trusted from the client:
 *  · owner  — the mobile is in the ADMIN_MOBILES env allowlist (bootstrap; cannot be
 *             revoked from the UI), or a staff row with role 'owner'
 *  · ops / support — an active row in `staff` (managed by an owner)
 *  · rider  — an active row in `riders` whose phone is this mobile
 * Every signed-in person is also a customer of their own data.
 *
 * Empty ADMIN_MOBILES and no staff rows = nobody is staff, which is the correct
 * default: an open admin panel is a data breach, not a missing feature.
 */

import type { ObjectId } from 'mongodb';
import { getSession, UnauthorizedError } from './auth';
import { getDb } from './db';
import { adminMobiles } from './env';
import { col, type Actor, type StaffRole } from './models';
import { ForbiddenError } from './errors';

export interface Principal {
  mobile: string;
  staffRole: StaffRole | null;
  staffName?: string;
  riderId: ObjectId | null;
  riderName?: string;
}

export async function principalFor(mobile: string): Promise<Principal> {
  const db = await getDb();
  let staffRole: StaffRole | null = adminMobiles().includes(mobile) ? 'owner' : null;
  let staffName: string | undefined;
  const staff = await col.staff(db).findOne({ mobile, active: true });
  if (staff) {
    staffName = staff.name;
    if (!staffRole) staffRole = staff.role;
  }
  const rider = await col.riders(db).findOne({ phone: mobile, active: true });
  return {
    mobile,
    staffRole,
    ...(staffName ? { staffName } : {}),
    riderId: rider?._id ?? null,
    ...(rider?.name ? { riderName: rider.name } : {}),
  };
}

/** The signed-in principal, or null when there is no session. */
export async function getPrincipal(): Promise<Principal | null> {
  const s = await getSession();
  if (!s) return null;
  return principalFor(s.mobile);
}

/** Any signed-in person. Throws UnauthorizedError (401). */
export async function requireSignedIn(): Promise<Principal> {
  const p = await getPrincipal();
  if (!p) throw new UnauthorizedError();
  return p;
}

/** Staff with one of `allowed` roles. 401 without a session, 403 otherwise. */
export async function requireStaff(
  allowed: readonly StaffRole[] = ['owner', 'ops', 'support'],
): Promise<Principal & { staffRole: StaffRole }> {
  const p = await requireSignedIn();
  if (!p.staffRole || !allowed.includes(p.staffRole)) throw new ForbiddenError();
  return p as Principal & { staffRole: StaffRole };
}

/** An active rider. 401 without a session, 403 when the mobile is not a rider. */
export async function requireRider(): Promise<Principal & { riderId: ObjectId }> {
  const p = await requireSignedIn();
  if (!p.riderId) throw new ForbiddenError('This number is not registered as a delivery partner.');
  return p as Principal & { riderId: ObjectId };
}

/** Is this mobile staff or rider? Used to keep their OTPs out of demo mode. */
export async function isPrivilegedMobile(mobile: string): Promise<boolean> {
  const p = await principalFor(mobile);
  return p.staffRole !== null || p.riderId !== null;
}

export function actorFor(p: Principal, as: Actor['kind']): Actor {
  return { kind: as, id: p.mobile };
}
