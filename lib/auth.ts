/**
 * Passwordless OTP auth on the 10-digit mobile number. No passwords, ever.
 *
 * Threat model shaped every choice here:
 *
 *  · The otps collection stores sha256(code + SESSION_SECRET), never the code. A
 *    dumped collection is not a set of live logins, and the secret is not in the
 *    row so an attacker with the DB still cannot recompute the hash.
 *  · The sessions collection stores sha256(rawToken); the raw token lives only in
 *    the httpOnly cookie. A dumped sessions collection is likewise not a set of
 *    usable cookies.
 *  · issueOtp NEVER reveals whether a mobile is registered — accounts are
 *    auto-provisioned on first successful verify, so "does this number exist" must
 *    not be answerable. The issue path behaves identically for known and unknown
 *    mobiles.
 *  · Rate limits are enforced server-side: 3 issues / mobile / 15 min, 5 verify
 *    attempts / otp doc. Both are the difference between OTP auth and an open door.
 */

import { createHash, randomInt, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { getDb } from './db';
import { col, normalizeMobile, type Session, type User } from './models';
import { requireEnv, adminMobiles, smsConfig, isProd, otpDemoMode } from './env';
import { sendAuthCode } from './notify';

export const SESSION_COOKIE = 'mv_session';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes; TTL index on expiresAt removes the doc
const OTP_MAX_ATTEMPTS = 5; // per otp doc, then it is dead
const ISSUE_WINDOW_MS = 15 * 60 * 1000; // rolling window for the issue-rate limit
const ISSUE_MAX = 3; // max issues per mobile per window
const ISSUE_MAX_PER_IP = 20; // per client IP per window — generous for a shared NAT (a society's wifi), fatal to a spray
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** sha256(value + SESSION_SECRET) as lowercase hex. The secret is the pepper. */
function pepperedHash(value: string): string {
  const secret = requireEnv('SESSION_SECRET');
  return createHash('sha256').update(`${value}${secret}`).digest('hex');
}

/** Plain sha256 hex — used for the session token, which is already 256 bits of entropy. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isAdminMobile(mobile: string): boolean {
  const normalized = normalizeMobile(mobile);
  return normalized !== null && adminMobiles().includes(normalized);
}

/**
 * The requesting client's IP for rate limiting. On Vercel the edge sets x-real-ip /
 * x-forwarded-for itself (client-supplied values are not passed through as the first
 * hop), so the first entry is the client. Returns undefined when absent or garbled —
 * the per-mobile limit still applies.
 */
export function clientIpFrom(h: Pick<Headers, 'get'>): string | undefined {
  const raw = h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0] ?? '';
  const ip = raw.trim();
  return ip && ip.length <= 45 && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : undefined;
}

/**
 * True when the WhatsApp auth channel is configured well enough to deliver a code:
 * provider is 'meta' AND the token + phone number id are present. Detected without
 * sending, so issueOtp can gate delivery on it before minting a code.
 */
function whatsappAuthConfigured(): boolean {
  const provider = (process.env.WHATSAPP_PROVIDER ?? '').trim().toLowerCase();
  if (provider !== 'meta') return false;
  const token = (process.env.WHATSAPP_TOKEN ?? '').trim();
  const phoneId = (process.env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
  return token !== '' && phoneId !== '';
}

export interface IssueResult {
  /** set when the mobile is on the admin allowlist: a code was minted and logged, but deliberately not returned. */
  adminCodeWithheld?: boolean;
  /** true when the code is being shown on screen in PRODUCTION via OTP_DEMO_MODE. */
  demo?: boolean;
  /** true when the code was accepted for delivery (or dev-logged). */
  ok: true;
  /** ONLY present when NODE_ENV !== 'production' and no SMS provider is configured. */
  devCode?: string;
}

export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super('Too many OTP requests. Try again later.');
    this.name = 'RateLimitError';
  }
}

/** No SMS provider configured while running in production — the route answers 503. */
export class SmsNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`SMS not configured — missing: ${missing.join(', ')}`);
    this.name = 'SmsNotConfiguredError';
  }
}

export class InvalidMobileError extends Error {
  constructor() {
    super('A valid 10-digit mobile number is required.');
    this.name = 'InvalidMobileError';
  }
}

/** A delivery channel is configured but the code could not be sent (→ 502). Nothing was echoed. */
export class OtpDeliveryError extends Error {
  constructor() {
    super('We could not send your code just now. Please try again in a minute.');
    this.name = 'OtpDeliveryError';
  }
}

/**
 * Issue a one-time code for `mobile`.
 *
 * Returns identically for registered and unregistered mobiles (no enumeration).
 * Throws RateLimitError (-> 429) when the mobile is over its issue budget, and
 * SmsNotConfiguredError (-> 503) in production with no SMS provider set.
 */
export async function issueOtp(mobile: string, opts: { ip?: string } = {}): Promise<IssueResult> {
  const normalized = normalizeMobile(mobile);
  if (!normalized) throw new InvalidMobileError();

  const db = await getDb();
  const otps = col.otps(db);
  const now = new Date();

  // Rolling-window issue-rate limit. createdAt is not TTL'd away until expiresAt,
  // and expiresAt (now + 5 min) always outlives the 15-min window's relevant tail
  // only partially — so count by createdAt, not by doc existence.
  const windowStart = new Date(now.getTime() - ISSUE_WINDOW_MS);
  const recent = await otps
    .find({ mobile: normalized, createdAt: { $gte: windowStart } })
    .sort({ createdAt: 1 })
    .toArray();

  if (recent.length >= ISSUE_MAX) {
    const oldest = recent[0];
    // when the oldest request ages out of the window, one slot frees
    const retryAfterMs = oldest ? oldest.createdAt.getTime() + ISSUE_WINDOW_MS - now.getTime() : ISSUE_WINDOW_MS;
    throw new RateLimitError(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  }

  /*
   * Decide delivery BEFORE minting a code, so a 503 does not leave a live OTP behind.
   *
   * DEMO MODE — read this before turning it on.
   *
   * With OTP_DEMO_MODE set, the code is returned in the HTTP response even in
   * production, so the flow can be demonstrated before an SMS gateway exists. That
   * means ANYONE WHO CAN REACH THE SITE CAN SIGN IN AS ANY MOBILE NUMBER. It is a
   * deliberate, temporary hole for a client demo — not a configuration to leave on.
   *
   * The one thing it will not do is hand out an ADMIN code. An admin mobile still
   * gets a real code minted and logged server-side, but it is withheld from the
   * response, so a demo visitor cannot walk into the fulfilment panel and the zone
   * editor. Whoever runs the demo can read that code from the server logs.
   */
  /*
   * Delivery seam order:
   *   1. WhatsApp (Cloud API) — the primary channel now that the platform is
   *      WhatsApp-first. When WHATSAPP_PROVIDER=meta, sendAuthCode delivers the code
   *      via the approved authentication template.
   *   2. SMS — kept as a fallback seam for numbers/regions where WhatsApp fails or
   *      is not desired. Unimplemented provider wire call (see sendSms).
   *   3. Dev/demo — no provider configured: dev-log the code, and echo it outside
   *      production (or in production only under OTP_DEMO_MODE), except for admins.
   *
   * We decide whether a real channel WILL deliver before minting, so a production
   * 503 does not leave a live OTP behind. WhatsApp being configured is detected
   * without sending, so we can gate on it here.
   */
  const sms = smsConfig();
  const demo = otpDemoMode();
  const whatsappReady = whatsappAuthConfigured();
  if (!whatsappReady && !sms.ok && isProd() && !demo) {
    throw new SmsNotConfiguredError(sms.missing);
  }

  // 6-digit code, cryptographically random, uniform over [100000, 999999].
  const code = String(randomInt(100000, 1000000));

  const inserted = await otps.insertOne({
    mobile: normalized,
    codeHash: pepperedHash(code),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    attempts: 0,
    createdAt: now,
    ...(opts.ip ? { ip: opts.ip } : {}),
  });

  // Enforce the limits AFTER inserting, counting our own row. Counting first and
  // inserting second lets N parallel requests all see "under the limit"; this way
  // every request that pushes a window over the limit removes itself.
  const overMobile = (await otps.countDocuments({ mobile: normalized, createdAt: { $gte: windowStart } })) > ISSUE_MAX;
  const overIp = opts.ip
    ? (await otps.countDocuments({ ip: opts.ip, createdAt: { $gte: windowStart } })) > ISSUE_MAX_PER_IP
    : false;
  if (overMobile || overIp) {
    await otps.deleteOne({ _id: inserted.insertedId });
    throw new RateLimitError(Math.ceil(ISSUE_WINDOW_MS / 1000));
  }

  // Primary: WhatsApp. 'sent' means the code left the building; nothing is echoed.
  if (whatsappReady) {
    const delivered = await sendAuthCode(normalized, code);
    if (delivered === 'sent') return { ok: true };
    // The send failed (provider error / outage). Fall through to SMS if there is one.
  }

  if (sms.ok) {
    await sendSms(normalized, code, sms.value);
    return { ok: true };
  }

  /*
   * No channel delivered the code. In PRODUCTION without demo mode this must end
   * here: falling through to the dev branch below would put the code in the HTTP
   * response, and a failed WhatsApp send (a Meta outage, an undeliverable number)
   * would become "request anyone's code and read it back" — account takeover.
   * The minted OTP is killed (attempts maxed) rather than deleted, so the attempt
   * still counts toward the issue-rate limit and cannot be used to spam the provider.
   */
  if (isProd() && !demo) {
    await otps.updateOne({ _id: inserted.insertedId }, { $set: { attempts: OTP_MAX_ATTEMPTS } });
    throw new OtpDeliveryError();
  }

  // No provider: either local development, or production with demo mode explicitly
  // enabled. Always log server-side so an operator can retrieve it.
  // eslint-disable-next-line no-console
  console.log(`[otp] ${normalized}: ${code}`);

  // Codes are never echoed to the browser for privileged numbers in the situations
  // where the echo is a real hole:
  //   · An OWNER (env allowlist) is ALWAYS withheld — dev or prod. An echoed owner
  //     code is the fulfilment panel and zone editor for anyone who can read it.
  //   · In PRODUCTION DEMO MODE the response is the public internet, so ANY
  //     privileged mobile (staff or rider — isPrivilegedMobile) is also withheld so
  //     a demo visitor cannot walk into a staff or rider surface.
  // In plain development the response is local, so a rider/staff dev code is still
  // echoed (current behaviour) — only owners are held back.
  const prodDemo = demo && isProd();
  // roles.ts imports this module, so a static import would be a cycle; load it
  // lazily only in the prod-demo branch that actually needs the DB-backed check.
  let privileged = false;
  if (prodDemo && !isAdminMobile(normalized)) {
    const { isPrivilegedMobile } = await import('./roles');
    privileged = await isPrivilegedMobile(normalized);
  }
  const withhold = isAdminMobile(normalized) || (prodDemo && privileged);
  if (withhold) {
    return { ok: true, adminCodeWithheld: true };
  }
  return { ok: true, devCode: code, demo: prodDemo };
}

/**
 * Actually hand the code to the SMS provider. Kept as a single seam so the rest of
 * the module never touches provider specifics. Deliberately generic: the provider's
 * concrete REST shape is a client decision that is not yet made, so this asserts the
 * contract (a configured provider + key) and leaves the wire call to when the
 * provider is chosen, rather than inventing an endpoint that would silently no-op.
 */
async function sendSms(mobile: string, code: string, cfg: Record<string, string>): Promise<void> {
  void mobile;
  void code;
  void cfg;
  // A configured-but-unimplemented provider must fail loudly, not pretend to send.
  throw new SmsNotConfiguredError(['SMS_PROVIDER integration not implemented']);
}

export class VerifyError extends Error {
  constructor() {
    super('That code is not valid or has expired.');
    this.name = 'VerifyError';
  }
}

/**
 * Verify `code` against the newest live OTP for `mobile`. On success: consumes the
 * OTP, auto-provisions the user if new, creates a session, sets the cookie, and
 * returns the RAW session token.
 *
 * Failure and expiry are indistinguishable to the caller (single VerifyError), so a
 * probe cannot tell "wrong code" from "no such request".
 */
export async function verifyOtp(mobile: string, code: string): Promise<string> {
  const normalized = normalizeMobile(mobile);
  if (!normalized) throw new VerifyError();
  if (!/^\d{6}$/.test(code)) throw new VerifyError();

  const db = await getDb();
  const otps = col.otps(db);
  const now = new Date();

  // Consume an attempt ATOMICALLY before comparing. A read-then-compare-then-increment
  // lets N parallel guesses all see "attempts < 5" and all be compared; with the
  // increment in the same findOneAndUpdate, at most OTP_MAX_ATTEMPTS requests ever get
  // this document back, however many arrive at once.
  const otp = await otps.findOneAndUpdate(
    { mobile: normalized, expiresAt: { $gt: now }, attempts: { $lt: OTP_MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { sort: { createdAt: -1 }, returnDocument: 'after' },
  );
  if (!otp?._id) throw new VerifyError();

  const matches = timingSafeEqualHex(otp.codeHash, pepperedHash(code));

  if (!matches) {
    // the last allowed attempt failed: kill the doc so it cannot be tried again
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await otps.deleteOne({ _id: otp._id });
    }
    throw new VerifyError();
  }

  // Correct code: burn every OTP for this mobile so it cannot be replayed.
  await otps.deleteMany({ mobile: normalized });

  // Auto-provision on first successful verify. users.mobile is unique, so the
  // upsert is race-safe: a concurrent verify from two devices cannot fork the row.
  const users = col.users(db);
  await users.updateOne(
    { mobile: normalized },
    {
      $setOnInsert: { mobile: normalized, createdAt: now } satisfies Partial<User>,
      $set: { lastSeenAt: now },
    },
    { upsert: true },
  );

  return createSessionCookie(normalized);
}

/** Constant-time hex comparison. Both inputs are fixed-length sha256 hex. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Mint a session, persist its hash, set the cookie, return the raw token. */
async function createSessionCookie(mobile: string): Promise<string> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const rawToken = randomBytes(32).toString('hex'); // 256 bits
  await col.sessions(db).insertOne({
    token: sha256Hex(rawToken), // store the HASH; the raw token lives only in the cookie
    mobile,
    isAdmin: isAdminMobile(mobile),
    createdAt: now,
    expiresAt,
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: isProd(), // over https in prod; plain http is fine for local dev
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });

  return rawToken;
}

export interface SessionInfo {
  mobile: string;
  isAdmin: boolean;
  user: User | null;
  expiresAt: Date;
}

/**
 * Read the current session from the cookie. Returns null when there is no cookie,
 * the token is unknown, or the session has expired. Safe to call from a server
 * component or a route handler.
 */
export async function getSession(): Promise<SessionInfo | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (!raw) return null;

  const db = await getDb();
  const now = new Date();
  const session = await col.sessions(db).findOne({
    token: sha256Hex(raw),
    expiresAt: { $gt: now },
  });
  if (!session) return null;

  const user = await col.users(db).findOne({ mobile: session.mobile });
  return {
    mobile: session.mobile,
    isAdmin: session.isAdmin,
    user,
    expiresAt: session.expiresAt,
  };
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Sign in to continue.');
    this.name = 'UnauthorizedError';
  }
}

/** Like getSession but throws UnauthorizedError (-> 401) when there is no session. */
export async function requireSession(): Promise<SessionInfo> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

/**
 * Destroy a session by its RAW token (as held in the cookie) and clear the cookie.
 * Idempotent: destroying an unknown token still clears the cookie and succeeds.
 */
export async function destroySession(token: string): Promise<void> {
  if (token) {
    const db = await getDb();
    await col.sessions(db).deleteOne({ token: sha256Hex(token) });
  }
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}
