import { ObjectId } from 'mongodb';
import { ValidationError } from '@/lib/errors';
import { isYMD } from '@/lib/cutoff';
import { EXTRA_LITRES, type ExtraInput } from '@/lib/extras';

/** Validate an extras request body. The mobile always comes from the session. */
export function parseExtraBody(body: Record<string, unknown>, mobile: string, withKey: boolean): ExtraInput {
  const issues: string[] = [];
  const { subscriptionId, date, kind, litres, useCredit, idempotencyKey } = body;
  if (typeof subscriptionId !== 'string' || !/^[a-f0-9]{24}$/i.test(subscriptionId)) issues.push('subscriptionId must be an id');
  if (typeof date !== 'string' || !isYMD(date)) issues.push('date must be YYYY-MM-DD');
  if (kind !== 'cow' && kind !== 'buffalo') issues.push('kind must be cow or buffalo');
  if (typeof litres !== 'number' || !(EXTRA_LITRES as readonly number[]).includes(litres)) issues.push('litres must be 0.5, 1, 1.5 or 2');
  if (useCredit !== undefined && typeof useCredit !== 'boolean') issues.push('useCredit must be true or false');
  if (withKey && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey))) {
    issues.push('idempotencyKey must be 8–100 letters, digits, - or _');
  }
  if (issues.length) throw new ValidationError('Invalid extra', issues);
  return {
    mobile,
    subscriptionId: new ObjectId(subscriptionId as string),
    date: date as string,
    kind: kind as 'cow' | 'buffalo',
    litres: litres as number,
    useCredit: useCredit !== false,
    idempotencyKey: withKey ? (idempotencyKey as string) : '',
  };
}
