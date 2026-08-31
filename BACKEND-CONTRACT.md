# BACKEND CONTRACT — read before writing any backend code

Foundation is already written and is **not** yours to change:

| file | what it owns |
|---|---|
| `lib/env.ts` | validated env access, `group()`, `adminMobiles()` |
| `lib/db.ts` | the ONE `getDb()`. Never construct a `MongoClient` |
| `lib/models.ts` | every collection type, `col.*` accessors, `normalizeMobile`, `INDEXES` |
| `lib/pricing.ts` | the ONLY source of prices. Never hardcode an amount |

If you need a new collection or field, **add it to `lib/models.ts`** and say so in
your report. Do not define types locally.

## Non-negotiables

**Money is paise, integer, always.** Field names end in `Paise`. Never floats,
never rupees. `lib/pricing.ts` already computes correctly — call `quote()`, do not
re-derive. A hand-typed amount is how the client's own matrix ended up with seven
arithmetic errors.

**Mobile is 10 digits, no country code.** It is the user identity. Run every
inbound value through `normalizeMobile()` or `+91 70752 02177` and `7075202177`
become two accounts.

**An unconfigured service returns 503 with the missing variable names.** It never
silently no-ops. Use `group()` / `razorpayConfig()` and answer honestly.

**Never invent a business fact.** If serviceability, a refund rule or a delivery
window is unknown, the API says unknown. An empty `pincodes` collection means we
deliver NOWHERE — the check must not default to yes.

**Secrets live in env only.** Never in code, never in a committed file, never in a
log line, never in an API response.

## Decisions already made — build to these

**Payments are PREPAID ORDERS, not auto-renew mandates.** Razorpay **Orders** API,
one payment for a fixed term. Not Subscriptions, not UPI Autopay, no mandate step.
The client's pricing is a fixed-term prepaid model (30/90/180/360 days at a
term discount), which is an Order. *This is a fork the client has not explicitly
confirmed — build Orders, keep the door open, do not build mandates.*

**Auth is OTP on the mobile number. There are no passwords.** Accounts are
auto-provisioned from the paid order, so the user never chooses a password —
owning a reset flow for credentials nobody set is pure liability.

**Admin is an env allowlist of mobiles** (`ADMIN_MOBILES`), checked server-side on
every admin request. Not a role field a compromised signup could set. Empty
allowlist = admin unreachable, which is the correct default.

**Razorpay webhooks must verify the HMAC signature** with
`RAZORPAY_WEBHOOK_SECRET` before the body is trusted, and must be **idempotent**
via `webhook_events.eventId` (Razorpay retries). An unverified webhook endpoint is
a free money-printing bug.

**Dates are `YYYY-MM-DD` in Asia/Kolkata.** A milk round is a local-calendar
concept; UTC dates roll over mid-round and produce a day's missed deliveries.

## Style

Match the codebase: TypeScript strict, `noUncheckedIndexedAccess` is on, no `any`.
Route handlers in `app/api/**/route.ts`. Comment the *why* where a decision is
non-obvious, not the *what*. No new dependencies without saying so — `mongodb` and
`sharp` are installed; `razorpay` is not (use `fetch` against their REST API and
node:crypto for the HMAC, which avoids the dependency entirely).

## Verification — required before you report

Run `pnpm typecheck`. It must pass. If you cannot reach a database, say so
explicitly rather than claiming a route works.

## Report back

- files you created or changed
- anything you added to `lib/models.ts`
- what you could NOT verify, and why
- any business decision you hit that only the client can answer
