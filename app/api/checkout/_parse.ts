/**
 * Body parsing for /api/checkout and /api/checkout/preview. Not a route.
 * The mobile NEVER comes from the body — it is the session's.
 */
import { ObjectId } from 'mongodb';
import type { AddressParts, DeliveryDetails, MilkKind } from '@/lib/models';
import { ValidationError } from '@/lib/errors';
import { isYMD } from '@/lib/cutoff';

export interface PlanFields {
  purpose: 'new' | 'renewal';
  kind: MilkKind;
  quantityId: string;
  tenureId: string;
  startDate?: string;
  renewsSubscriptionId?: ObjectId;
  useCredit: boolean;
}

const str = (v: unknown, max = 200): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined;

export function parsePlan(b: Record<string, unknown>): PlanFields {
  const issues: string[] = [];
  const purpose = b.purpose === undefined ? 'new' : b.purpose;
  if (purpose !== 'new' && purpose !== 'renewal') issues.push('purpose must be "new" or "renewal"');
  if (b.kind !== 'cow' && b.kind !== 'buffalo') issues.push('kind must be "cow" or "buffalo"');
  if (typeof b.quantityId !== 'string') issues.push('quantityId is required');
  if (typeof b.tenureId !== 'string') issues.push('tenureId is required');
  if (b.startDate !== undefined && (typeof b.startDate !== 'string' || !isYMD(b.startDate))) issues.push('startDate must be YYYY-MM-DD');
  let renews: ObjectId | undefined;
  if (purpose === 'renewal') {
    if (typeof b.renewsSubscriptionId !== 'string' || !ObjectId.isValid(b.renewsSubscriptionId)) {
      issues.push('renewsSubscriptionId is required for a renewal');
    } else renews = new ObjectId(b.renewsSubscriptionId);
  }
  if (b.useCredit !== undefined && typeof b.useCredit !== 'boolean') issues.push('useCredit must be true or false');
  if (issues.length) throw new ValidationError('Invalid checkout request', issues);
  return {
    purpose: purpose as 'new' | 'renewal',
    kind: b.kind as MilkKind,
    quantityId: b.quantityId as string,
    tenureId: b.tenureId as string,
    ...(typeof b.startDate === 'string' ? { startDate: b.startDate } : {}),
    ...(renews ? { renewsSubscriptionId: renews } : {}),
    useCredit: b.useCredit === true,
  };
}

function parseAddressParts(v: unknown): AddressParts | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ValidationError('addressParts must be an object');
  const o = v as Record<string, unknown>;
  const house = str(o.house, 100);
  if (!house) throw new ValidationError('addressParts.house (flat / house number) is required');
  const pincode = str(o.pincode, 6);
  if (pincode && !/^\d{6}$/.test(pincode)) throw new ValidationError('addressParts.pincode must be 6 digits');
  const out: AddressParts = { house };
  for (const k of ['floor', 'building', 'society', 'area'] as const) {
    const s = str(o[k], 120);
    if (s) out[k] = s;
  }
  if (pincode) out.pincode = pincode;
  return out;
}

export function parseDetails(v: unknown): DeliveryDetails {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ValidationError('details is required');
  const o = v as Record<string, unknown>;
  const loc = o.location as Record<string, unknown> | undefined;
  const addressParts = parseAddressParts(o.addressParts);
  const landmark = str(o.landmark, 300);
  const instructions = str(o.instructions, 500);
  return {
    name: typeof o.name === 'string' ? o.name.trim().slice(0, 100) : '',
    address: typeof o.address === 'string' ? o.address.trim().slice(0, 500) : '',
    ...(loc && typeof loc === 'object' ? { location: { lat: Number(loc.lat), lng: Number(loc.lng) } } : {}),
    ...(landmark ? { landmark } : {}),
    ...(instructions ? { instructions } : {}),
    ...(addressParts ? { addressParts } : {}),
  };
}
