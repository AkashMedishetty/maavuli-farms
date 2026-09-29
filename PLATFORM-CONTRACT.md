# PLATFORM CONTRACT — read fully before writing any code

Maavuli is becoming a full milk-subscription platform: customers (onboarding with an
exact map pin, dashboard), delivery partners (rider app with photo proof and Google
Maps navigation), ops (admin console), WhatsApp notifications, and a daily engine
(cutoff → lock → deliver → close) with explicit states for everything.

This file + the FOUNDATION files below are the shared surface. BACKEND-CONTRACT.md
still applies (money in paise, mobile normalisation, 503 for unconfigured services,
never invent business facts, secrets only in env).

## 0. Where and how you work

- Worktree: `/Users/akash/CTX/Websites/maavuli-platform` (branch `feat/platform`).
  NEVER touch `/Users/akash/CTX/Websites/Maavuli Farms` (the user's main checkout).
- Use absolute paths. Do not glob or recursively search the repo — every file you
  need is named here or in your brief; read those paths directly.
- Git: read-only only (`git status`, `git diff`). Never commit, checkout, stash,
  reset or push — the orchestrator commits.
- No new dependencies (`@vercel/blob` 2.8.0 and `tsx` are already installed). If you
  truly need one, stop and put it under Requests in your report.
- Do NOT spawn sub-agents. Work sequentially.
- Do not print or read secret values from `.env.local` (key names are fine).
- Do not run `next build`, and do not take screenshots. The orchestrator builds;
  Akash reviews UI himself.
- Only edit files you OWN (section 6). Need a change elsewhere? Write it under
  "Requests" in your report — do not make it.

### Commands (run from the worktree)
- `pnpm typecheck` — must be clean for YOUR files. Other agents are editing in
  parallel, so errors in files you do not own may appear; list them, don't fix them.
- Unit tests (pure, no DB): `pnpm test:<name>` → `scripts/verify-<name>.ts`, run with
  tsx. Import pure modules with RELATIVE paths.
- Integration tests (real Mongo, isolated per agent): write
  `scripts/it/<agent>-<topic>.ts` (may import `@/lib/...`), then
  `MONGODB_DB=maavuli_it_<agent> pnpm db:init` once, then
  `MONGODB_DB=maavuli_it_<agent> pnpm run it scripts/it/<agent>-<topic>.ts` (NOT `pnpm it` — that is pnpm's built-in install-test alias).
  Build every lib call's `ctx` with an explicit `now` to exercise cutoffs. Clean up
  your own test data or use fresh mobiles (e.g. `9<agent digit>xxxxxxxx`).
- Do NOT start a dev server (`next dev`) or run `next build`: the host is memory-tight
  and four agents already died from it. Test lib code with the integration scripts;
  route handlers are exercised later by the e2e suite. Run `pnpm typecheck` at most
  once per numbered item, and integration scripts one at a time.

### Report (write it FIRST as a skeleton, update after each unit of work)
`/Users/akash/CTX/Websites/maavuli-platform/.agents/reports/<agent>.md` with:
Files changed · Implemented · Verified (exact commands + results) · NOT verified and
why · Contract deviations · Requests (changes needed in files you don't own) ·
Business questions only the client can answer.

## 1. FOUNDATION (frozen — read, do not edit)

| file | what it gives you |
|---|---|
| `lib/models.ts` | every collection type, `col.*`, `COL`, `INDEXES`, `REASON_FAULT`, `stopKeyOf`, `normalizeMobile` |
| `lib/cutoff.ts` | PURE IST day arithmetic: `firstOpenDate`, `lockInstant`, `closeInstant`, `windowInstants`, `istYMD`, `addDaysYMD`, `daysBetween`, `hmLabel`, `validateDayRules` |
| `lib/daylock.ts` | `isDateLocked`, `firstOpenDateNow`, `assertDateOpen` (time AND materialised day_locks) |
| `lib/settings.ts` | `getOpsSettings`, `updateOpsSettings`, `dayRulesOf`, `DEFAULT_OPS` |
| `lib/transitions.ts` | allowed transition tables + `assertTransition` (→ IllegalTransitionError, 409) |
| `lib/clock.ts` | `OpCtx {now, actor}`, `ctxFor(req, actor)`, `systemCtx`, `pageNow`, actors |
| `lib/events.ts` | `recordEvent(ctx, ev)` (never throws), `customerTimeline`, `entityHistory` |
| `lib/roles.ts` | `getPrincipal`, `requireSignedIn`, `requireStaff(roles)`, `requireRider`, `isPrivilegedMobile`, `actorFor` |
| `lib/api.ts` | `ok`, `jsonError`, `readJson`, `handleRouteError` (the ONLY error→status mapping) |
| `lib/errors.ts` | `ValidationError` 400, `NotFoundError` 404, `ConflictError` 409, `ForbiddenError` 403, `DateLockedError` 409, `ServiceNotConfiguredError` 503, `UpstreamError` 502 |

Stub files with FIXED signatures (the owner implements the bodies; everyone else
imports them as-is): `lib/orders.ts`, `lib/manifest.ts`, `lib/credits.ts`,
`lib/refunds.ts`, `lib/compensation.ts`, `lib/extras.ts`, `lib/route-plan.ts`,
`lib/maps-links.ts`, `lib/outcomes.ts`, `lib/storage.ts`, `lib/notify/index.ts`,
`lib/tickets.ts`, and the four new functions at the top of `lib/subscriptions.ts`.
An owner may ADD exports; changing an existing signature needs a Request.

## 2. Non-negotiables (new)

1. Business time is `ctx.now`. Never `new Date()` for a decision in lib code. Routes
   build ctx with `ctxFor(req, actor)` (honours `x-maavuli-now` only outside
   production with MAAVULI_TIME_TRAVEL=1). Record timestamps (createdAt) may use ctx.now too.
2. Every status write: `assertTransition(...)` first, a conditional update that
   matches the FROM state (`updateOne({_id, status: from}, ...)`, check matchedCount —
   concurrent writers must not both win), then `recordEvent` with `from`/`to`,
   `mobile` (when customer-related) and a `type` of `<entity>.<verb>`.
3. Identity comes from the session, NEVER from the body. Customer routes return 404
   (not 403) for another customer's resources. Rider routes only see the rider's
   own runs. Staff routes use `requireStaff([...])` per the matrix in section 7.
4. Route handlers: `export const dynamic = 'force-dynamic'`, try/catch →
   `handleRouteError(err)`. Validate every input field (types, ranges, ObjectId,
   YYYY-MM-DD via `isYMD`). No stack traces or secrets in responses.
5. Idempotency: checkout (idempotencyKey), payment activation, webhooks
   (webhook_events), rider actions (rider_actions.actionId), messages (outbox
   dedupeKey), refunds (one per subscription), compensation (once per delivery).
6. Honest states in UI: loading → error → empty → data, never an empty state for a
   failed fetch. Money shown with `formatINR`. Dates shown in IST.
7. TypeScript strict, `noUncheckedIndexedAccess`, no `any`. Pure modules must not
   import `@/...` or DB code (tests import them relatively).
8. New code never writes legacy statuses (delivery `scheduled|skipped|failed`,
   subscription `paused`) — read them only where old data may appear.

## 3. The daily clock (all times IST, from `settings`)

- `cutoffTime` (default 16:00) on the day BEFORE a delivery date: that date locks.
  Customer changes (pause, unpause, cancel-from, extra, first delivery, address
  change) apply only to dates ≥ `firstOpenDateNow(ctx)`; otherwise DateLockedError.
- Lock (tick, or lazily via `ensureLocked` whenever a manifest/rider run is read):
  planned → locked, each delivery stamped with riderId (zone's rider, null =
  unassigned), runId, seq, stopKey, snapshot; one RiderRun per rider; a day_locks doc.
  First-delivery notices go out here.
- Window `windowStart`–`windowEnd` (05:30–08:00): riders start runs
  (locked → out_for_delivery for the run's rows) and mark each stop.
- `dayCloseTime` (10:00): locked|out_for_delivery → unconfirmed; runs → completed/closed.
- 24 h after close: unconfirmed → not_delivered (reason 'other', fault 'ours') and
  compensated. The customer never pays for our missing data.

## 4. Business rules

**Start date.** A new plan's first delivery = max(requested startDate,
`firstOpenDateNow`), requested ≤ 30 days out. Status 'scheduled' until that date,
then 'active' (tick). Deliveries for every term day are created at activation
(status 'planned', source 'plan'), skipping already-paused dates.

**Renewal.** Checkout purpose 'renewal' with renewsSubscriptionId (same customer,
status scheduled|active, no renewedBy yet): the new subscription starts the day
after the renewed one's endDate (or the first open date if that has passed) and the
two are linked (renewedBy / renewalOf). A second purchase WITHOUT purpose 'renewal'
is a parallel plan (e.g. cow + buffalo) and starts at the first open date.

**Extending** (pause shift or make-up day) goes through `extendSubscription`, which
appends after endDate and shifts a queued, not-yet-started renewal by the same days.

**Pause.** Existing calendar semantics (allowance, one appended day per paused day),
but the cutoff comes from settings via lib/daylock.

**Cancellation (the published policy).** Effective from `firstOpenDateNow`: planned
deliveries from that date are deleted; locked/out/delivered ones stay and count as
charged. Refund:
- chargedDays = delivered + locked + out_for_delivery + unconfirmed plan/makeup rows
- standardDailyPaise = base rate × litres/day (the 1-month, 0 % rate, lib/pricing)
- balance = max(0, amountPaise − chargedDays × standardDailyPaise)
- plus unspent refundable credit from this subscription's missed days
- the part up to (amountPaise − creditAppliedPaise) goes back to the original
  payment (Razorpay refunds API); anything beyond that goes back to credit.
- Razorpay cannot refund payments older than 6 months → status awaiting_upi: the
  customer gives a UPI id, ops pays it and records the UTR (paid_manually).
Example: 1 L cow, 1 year = ₹35,190; cancelled after 60 charged days → 60 × ₹115 =
₹6,900 charged → ₹28,290 refunded. The refund reaches ₹0 at day 306.

**Missed deliveries.** Rider reasons map to fault via `REASON_FAULT`; only staff may
set fault explicitly (and must resolve 'unknown'). Fault 'ours' → compensation once:
customer preference `makeup_day` (default) and the plan can be extended → one
make-up day (source 'makeup'); otherwise (preference 'credit', plan ended/cancelled,
or the row is an extra) → refundable credit = that day's value at the price PAID
(order.perLitrePaise × litres; extras: their price). Fault 'customer' → nothing.

**Credits.** Immutable ledger; balance = sum. Spend at checkout (renewal/new) and for
extras is debited at order creation and reversed if the order expires/fails. An
order fully covered by credit skips Razorpay (`razorpayOrderId = credit_<id>`) and
activates immediately. Staff goodwill credits: support ≤ ₹200, ops ≤ ₹1,000, owner
≤ ₹10,000 per entry; not refundable.

**Extras.** Only for a customer with a scheduled/active plan; one extra per
subscription per date; date ≥ first open date; litres ∈ {0.5, 1, 1.5, 2}; price =
base rate × litres; delivered to that subscription's address.

**Proof of delivery.** "Delivered" requires a photo (compressed on the phone to
≤ 1280 px JPEG/WebP, ~150 KB) plus the phone's GPS. If the camera is unavailable the
rider must type a note instead, and the stop is flagged. Distance from the pin >
`proofDistanceFlagM` is flagged. Photos are private; served only through
`/api/photos/[...key]` to staff, the rider who took it (that day) and the customer.

**Location.** Every new order requires `location {lat,lng}` inside an active zone.
The pin is the stop identity (`stopKeyOf`). Address/pin changes apply from the first
open date and mark both old and new riders' routes dirty.

**Routing.** Each rider has a standing route (stop keys in order). The daily lock
orders that day's stops with `orderStopsForRider` (no API calls: standing order
minus absent stops, new stops inserted cheapest-first). Re-optimisation
(`optimizeStandingRoute`) uses the Google Routes API computeRoutes with
`optimizeWaypointOrder` (≤ 25 intermediates) when GOOGLE_MAPS_SERVER_KEY is set and
the daily and monthly caps (GOOGLE_ROUTES_DAILY_CAP 100, GOOGLE_ROUTES_MONTHLY_CAP 3000, counted in api_usage) allow; travel mode DRIVE for optimisation (Pro SKU), two-wheeler only in the free navigation links; otherwise the
local solver (lib/routing). It runs only for dirty routes and routes older than 25
days. Riders navigate with `navigationLinks` (batches of ≤ 10 stops, two-wheeler,
turn-by-turn) and per-stop `stopNavigationUrl`.

**Notifications.** Only customers with `whatsappOptIn` get messages (others:
outbox 'suppressed'). Language from `user.lang`. Who enqueues what (dedupe key):

| template | params | enqueued by, when | dedupeKey |
|---|---|---|---|
| order_confirmed | name, plan, startDate, endDate, amount | B1 order paid (new/renewal) | `order_confirmed:<orderId>` |
| first_delivery_tomorrow | date, window | B2 lockDay, subs whose startDate = date | `first_delivery:<subId>` |
| delivered_today | time (+ mediaUrl photo) | B5 markDelivered, only if user.notifyDailyDelivered | `delivered:<deliveryId>` |
| not_delivered_ours | date, resolution | B3 compensation (skip when reason = disruption) | `missed:<deliveryId>` |
| not_delivered_customer | date, reason | B5 markNotDelivered with fault customer | `missed_c:<deliveryId>` |
| pause_confirmed | dates, endDate | B1 pause | `pause:<subId>:<first date>:<count>` |
| cancellation_confirmed | lastDate, refund | B1 cancel | `cancel:<subId>` |
| refund_processed | amount | B3 processed / paid_manually | `refund_done:<refundId>` |
| refund_needs_upi | amount, link | B3 → awaiting_upi | `refund_upi:<refundId>` |
| renewal_reminder | daysLeft, endDate, link | B6 tick | `renewal:<subId>:<daysLeft>` |
| extra_confirmed | date, litres, kind | B3 extra activated | `extra:<orderId>` |
| disruption_notice | date, reason, resolution | B2 disruption | `disruption:<disruptionId>:<mobile>` |
| ticket_update | status, note | B6 resolveTicket | `ticket:<ticketId>:<status>` |

## 5. Tick (`/api/cron/tick`, every 5 min; each step leased in job_runs, errors isolated)

1 `expireUnpaidOrders` (B1) · 2 `activateDueSubscriptions` (B1) · 3 `lockDueDays` (B2) ·
4 `closeDueDays` (B2) · 5 `autoResolveStaleUnconfirmed` (B2) · 6 `compensatePendingMisses`
(B3 — retries any fault-'ours' miss whose compensation failed) · 7
`completeEndedSubscriptions` (B1) · 8 `enqueueRenewalReminders` (B6) · 9 `drainOutbox`
(B6) · 10 `refreshStaleRoutes` (B4) · 11 `purgeOldPhotos` (B5).

**Status after wave 1 (commit f7cbff1):** B4 routing, B5 rider app and B6 notifications
are DONE and committed — call their modules as-is. `lib/outcomes` never throws on a
compensation failure (the sweep in step 6 retries) and calls `reverseCompensation` when
a miss is corrected to delivered or its fault moves ours → customer. B2's lane (day
engine) is being built by the orchestrator directly.

## 6. Ownership (edit ONLY your files; create new files only inside your area)

**Wave 1 (backend + rider app)**
- **B1 subscriptions & orders** — `lib/subscriptions.ts`, `lib/orders.ts`,
  `lib/pause.ts`, `app/api/checkout/**`, `app/api/payments/**`,
  `app/api/subscriptions/**`, `app/api/admin/settings/**`,
  `scripts/migrate-platform.ts`, `scripts/verify-lifecycle*.ts`, `scripts/it/b1-*`.
- **B2 day engine** — `lib/manifest.ts`, `lib/jobs.ts`, `lib/disruptions.ts`,
  `app/api/cron/**`, `app/api/admin/manifest/**`, `app/api/admin/days/**`,
  `app/api/admin/runs/**`, `app/api/admin/disruptions/**`, `vercel.json`,
  `scripts/seed-dev.ts`, `scripts/roll-deliveries.mjs` (retire it), `scripts/it/b2-*`.
- **B3 money** — `lib/credits.ts`, `lib/refunds.ts`, `lib/compensation.ts`,
  `lib/extras.ts`, `lib/razorpay.ts`, `app/api/webhooks/razorpay/**`,
  `app/api/extras/**`, `app/api/account/credits/**`, `app/api/account/refunds/**`,
  `app/api/admin/refunds/**`, `app/api/admin/credits/**`, `lib/legal.ts`,
  `app/legal/**`, `scripts/verify-refunds.ts`, `scripts/it/b3-*`.
- **B4 routing** — `lib/route-plan.ts`, `lib/google-routes.ts`, `lib/maps-links.ts`,
  `lib/routing.ts`, `app/api/admin/routes/**`, `scripts/verify-maps-links.ts`,
  `scripts/verify-routing.ts`, `scripts/it/b4-*`.
- **B5 rider app** — `lib/rider.ts`, `lib/outcomes.ts`, `lib/storage.ts`,
  `app/rider/**`, `app/api/rider/**`, `app/api/photos/**`,
  `app/api/admin/deliveries/**`, `components/rider/**`, `public/rider.webmanifest`,
  `public/sw.js`, `scripts/verify-rider.ts`, `scripts/it/b5-*`.
- **B6 notifications** — `lib/notify/**`, `lib/tickets.ts`, `lib/auth.ts`,
  `app/api/auth/**`, `app/api/webhooks/whatsapp/**`, `app/api/admin/messages/**`,
  `app/api/admin/tickets/**`, `scripts/verify-notify.ts`, `scripts/it/b6-*`.

**Wave 2 (UI, starts after wave 1)** — B7a admin ops (`app/admin/**` today,
tomorrow, exceptions, riders, routes, settings, disruptions; `components/admin/ops/**`;
`lib/admin.ts`; existing `RidersPanel`, `ZoneMap`, `app/api/admin/riders|zones|route|round|delivery|subscriptions`);
B7b admin customers & finance (`app/admin/customers|orders|refunds|subscriptions|messages|staff/**`,
`components/admin/crm/**`, `lib/admin-customers.ts`, `app/api/admin/customers|orders|staff/**`);
B8 onboarding (`app/subscribe/**`, `components/LocationPicker*`, `components/RazorpayCheckout.tsx`,
`app/api/serviceability/**`, `lib/serviceability.ts`); B9 customer dashboard
(`app/account/**`, `components/account/**`, `components/PauseCalendar.tsx`,
`components/CancelSubscription.tsx`, `lib/account.ts`, `app/api/account/**` except
credits/refunds); B10 e2e (`scripts/e2e/**`).

Shared files owned by the ORCHESTRATOR (request changes, never edit): everything in
section 1, `package.json`, `.env.example`, `.gitignore`, `app/layout.tsx`,
`app/globals.css`, `lib/env.ts`, `lib/db.ts`, `lib/pricing.ts`, `lib/geo.ts`,
`next.config.ts`, `tsconfig.json`. UI agents put styles in their own CSS files
(e.g. `app/rider/rider.css`), never in globals.css.

## 7. Access matrix

| surface | who |
|---|---|
| `/api/account/**`, checkout, extras, subscription actions | the signed-in customer, own resources only (404 otherwise) |
| `/api/rider/**`, `/rider` | requireRider; own runs only |
| admin reads (manifest, customers, orders, refunds, messages, routes, tickets) | owner, ops, support |
| admin ops actions (lock, assign, outcome/fault, disruptions, optimise, refund process/manual) | owner, ops |
| goodwill credit | owner, ops, support (per-role caps, §4) |
| settings PUT, staff management | owner |
| `/api/cron/tick` | `Authorization: Bearer $CRON_SECRET` only |
| webhooks | provider signature only (Razorpay HMAC; WhatsApp X-Hub-Signature-256) |

## 8. Environment (see .env.example)

`CRON_SECRET`, `MAAVULI_TIME_TRAVEL`, `STORAGE_DRIVER` (vercel-blob|local),
`BLOB_READ_WRITE_TOKEN`, `GOOGLE_MAPS_SERVER_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_KEY`,
`GOOGLE_ROUTES_DAILY_CAP`, `GOOGLE_ROUTES_MONTHLY_CAP`, `WHATSAPP_PROVIDER` (log|meta), `WHATSAPP_API_BASE`,
`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`,
`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_AUTH_TEMPLATE`, plus the existing ones. Read env
only inside functions (never at module scope), via `process.env` with trimming, or
`group()` from lib/env. Missing config → ServiceNotConfiguredError naming the vars,
except where a documented local fallback exists (routing → local solver, storage →
local driver outside production, WhatsApp → log driver outside production).

## 9. UI rules (wave 2)

- Mobile first: design at 360 px, no horizontal overflow, tap targets >= 44 px,
  body text >= 15 px. Ops use the admin on a phone at 5 AM; riders only use phones.
- Server components load data and check access (`requireStaff([...])` /
  `getPrincipal()`); client components only for interaction. A client component
  must NEVER import `lib/db`, `lib/models` runtime values, `mongodb` or any module
  that does — pass plain JSON props, or fetch the API. Types-only imports are fine
  (`import type`).
- Mutations call the documented API with `fetch` (same origin, JSON). While pending:
  disable the control and say what is happening. On error: show the API's `error`
  string (and `issues[]` when present) next to the control, keep the user's input.
  On success: `router.refresh()` (or update local state) — never a silent no-op.
- Every data view has the loading → error → empty → data ladder. An empty state on a
  failed fetch is a bug (it reads as "nothing to do" during an outage).
- Formatting: money `formatINR(paise)` (lib/pricing), litres `1.5 L`, dates
  "Thu 2 Oct" in Asia/Kolkata (`dateLabel` in lib/manifest is server-side; client
  code formats with `Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', ... })`).
- Styling: brand tokens from app/globals.css (`--red`, `--red-deep`, `--milk`,
  `--serif`, `--sans`) in YOUR OWN css file, imported by your layout/page. Never edit
  app/globals.css. Admin is a dense, light, high-contrast work tool (white ground,
  dark text, red accents) — not the red marketing pages.
- Access in UI mirrors §7 exactly: support sees ops screens read-only (hide or
  disable actions, and the API refuses anyway).
- No new dependencies. Maps: the Leaflet CDN pattern in components/ZoneMap.tsx
  (pinned version + SRI) is the only map library.
- Verification for UI agents: `pnpm typecheck` plus reading your own components for
  server/client-boundary mistakes. No dev server, no build, no screenshots — the
  orchestrator builds and the e2e lane walks every page.
