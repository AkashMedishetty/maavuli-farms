/**
 * Environment access, validated once.
 *
 * Rule for this codebase: a service that is not configured must FAIL LOUDLY, not
 * degrade into pretending. A checkout route that silently no-ops because
 * RAZORPAY_KEY_SECRET is missing is worse than one that returns 503 — the first
 * loses orders invisibly, the second is a bug report.
 *
 * Nothing here is read at module scope in a way that breaks the build: `requireEnv`
 * throws at REQUEST time, so `next build` never needs production secrets.
 */

export type Configured<T> = { ok: true; value: T } | { ok: false; missing: string[] };

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** Throw with the exact variable name. Use inside route handlers, never at import. */
export function requireEnv(name: string): string {
  const v = read(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

/** Non-throwing group check, so a route can answer 503 with a useful body. */
export function group<const N extends readonly string[]>(names: N): Configured<Record<N[number], string>> {
  const out = {} as Record<string, string>;
  const missing: string[] = [];
  for (const n of names) {
    const v = read(n);
    if (v) out[n] = v;
    else missing.push(n);
  }
  return missing.length ? { ok: false, missing } : { ok: true, value: out };
}

export const MONGO_KEYS = ['MONGODB_URI', 'MONGODB_DB'] as const;
export const RAZORPAY_KEYS = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const;
export const AUTH_KEYS = ['SESSION_SECRET'] as const;
export const SMS_KEYS = ['SMS_PROVIDER', 'SMS_API_KEY', 'SMS_SENDER_ID'] as const;

export const mongoConfig = () => group(MONGO_KEYS);
export const razorpayConfig = () => group(RAZORPAY_KEYS);
export const authConfig = () => group(AUTH_KEYS);
export const smsConfig = () => group(SMS_KEYS);

/**
 * Admin access is an explicit allowlist of mobile numbers, not a role flag that
 * could be set by a compromised signup path. Empty list = admin is unreachable,
 * which is the correct default: an open admin panel is a data breach, not a bug.
 */
export function adminMobiles(): string[] {
  return (read('ADMIN_MOBILES') ?? '')
    .split(',')
    .map(s => s.replace(/\D/g, ''))
    .filter(s => s.length === 10);
}

export const isProd = () => process.env.NODE_ENV === 'production';
