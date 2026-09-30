# Maavuli platform — test plan

What to test, how, with which accounts, and the mock data to type in. Work top to
bottom: sections 1–4 are setup, 5 is how to get into each side, 6 is the tests.

## 1. Where to test

| Place | URL | Notes |
|---|---|---|
| Vercel site (staging) | https://maavuli-farms.vercel.app | Deploys automatically from `main`. |
| Customer side | `/`, `/plans`, `/subscribe`, `/account` | Sign-up, payment, the customer's account. |
| Rider app | `/rider` | Open on the rider's phone. Has its own sign-in. |
| Admin console | `/admin` | Owners, ops and support staff only. |
| Policies | `/legal/terms`, `/legal/privacy`, `/legal/refunds`, `/legal/shipping` | |
| Local machine | http://127.0.0.1:3000 | Setup B below. |

maavulifarmmilk.com still serves the OLD site (an Apache server), not this platform.

State of the Vercel site when this was written (checked from outside, no login):
pages all answer 200; **scheduled jobs are OFF** — `/api/cron/tick` answers "Scheduled
jobs are not configured, missing CRON_SECRET". Until CRON_SECRET is set, unpaid orders
never expire, days never lock or close, and no WhatsApp message is ever sent. The
other variables could not be checked from outside: compare section 2 against Vercel →
Settings → Environment Variables.

## 2. Credentials and settings

Secrets never go in the repo or in this file. They live in Vercel → Project →
Settings → Environment Variables (and `.env.local` on a laptop). **After changing any
variable on Vercel, redeploy** — a variable only reaches deployments made after it.

| Variable | What it is for | Where to get it | For testing |
|---|---|---|---|
| `MONGODB_URI` | Database connection | MongoDB Atlas → Connect | Already set (the site works) |
| `MONGODB_DB` | Database name | You choose | `maavuli` = the real data. `maavuli_test` = mock data (Setup A) |
| `SESSION_SECRET` | Signs sign-in sessions and codes | `openssl rand -hex 32` | Required. Changing it signs everyone out |
| `ADMIN_MOBILES` | Owner mobiles, comma-separated, 10 digits | Your own number(s) | Required, or nobody can open `/admin` |
| `CRON_SECRET` | Lets Vercel run the 5-minute job | `openssl rand -hex 32` | **Missing now — set it first** |
| `OTP_DEMO_MODE` | `1` shows customers' sign-in codes on screen | — | Test databases ONLY (see warning below) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Payments | Razorpay Dashboard → switch to **Test mode** → Account & Settings → API keys | Test-mode keys (`rzp_test_…`) |
| `RAZORPAY_WEBHOOK_SECRET` | Verifies Razorpay's calls | You invent it when creating the webhook (section 3) | Required for refunds and payment backups |
| `WHATSAPP_PROVIDER` | `log` = messages recorded, never sent. `meta` = WhatsApp Cloud API | — | `log` for mock data |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_AUTH_TEMPLATE`, `WHATSAPP_API_BASE` (optional) | Real WhatsApp | Meta Business → WhatsApp → API setup (templates must be approved) | Only for the real-WhatsApp tests (6.10) |
| `STORAGE_DRIVER` + `BLOB_READ_WRITE_TOKEN` | Delivery photos | Vercel → Storage → Create → Blob, choose **Private** (cannot be changed later) → connect to this project. The app reads `BLOB_READ_WRITE_TOKEN` itself (riders' phones upload with it), so check it is in the project's variables; if only `BLOB_STORE_ID` appeared, copy the read-write token from the store's page | `vercel-blob`; without both, delivery photos cannot be saved on Vercel — a rider can then only mark a delivery with a note, and it is flagged for ops |
| `NEXT_PUBLIC_SITE_URL` | Absolute links (photo links in WhatsApp) | — | `https://maavuli-farms.vercel.app` |
| `GOOGLE_MAPS_SERVER_KEY` | Route optimisation (Routes API) | Google Cloud Console, billing on, restrict to Routes API | Optional: without it, routes are ordered locally |
| `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | Map + address search on sign-up | Google Cloud Console, Maps JS + Places, restricted to the site's domain | Optional: without it the free OpenStreetMap picker is used |
| `GOOGLE_ROUTES_DAILY_CAP` / `GOOGLE_ROUTES_MONTHLY_CAP` | Cost backstop for Google calls | — | Leave unset (defaults apply) |
| `FARM_ORIGIN_LAT` / `FARM_ORIGIN_LNG` | Where routes start | The farm's map pin | Optional; set both or neither |
| `MAAVULI_TIME_TRAVEL` | Lets tests move the clock | — | Local/e2e only; ignored on Vercel |
| `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID` | SMS fallback | — | Leave UNSET on Vercel: the SMS sender is not built, so with all three set, any sign-in that WhatsApp does not deliver fails — including every sign-in in demo mode |

**OTP_DEMO_MODE warning.** With it on, anyone who can reach the site can sign in as ANY
customer mobile. The `maavuli` database holds the orders imported from the old site, so
never turn it on while `MONGODB_DB=maavuli`. Owner, staff and rider codes are never shown
on screen even in demo mode; they are written to the server log (section 5).

## 3. Setting up a test run

### Setup A — the Vercel site on a test database (recommended)

Keeps the real data untouched while you test with mock data.

1. On your laptop, in the project folder (with `MONGODB_URI` in `.env.local`), create and
   fill the test database. **Done on 30 Sep 2026** on the cluster in `.env.local`
   (`maavulifarms.amqgozs.mongodb.net`); re-running is safe and changes nothing:
   ```sh
   MONGODB_DB=maavuli_test pnpm db:init
   MONGODB_DB=maavuli_test pnpm db:seed-dev
   ```
   `db:seed-dev` adds the settings, three test zones, three riders and two staff (section 4).
   It refuses any database whose name lacks `_dev`, `_test`, `_e2e`, `_it_` or `_demo`, so it
   cannot touch the real data.
2. On Vercel (Production environment) set: `MONGODB_DB=maavuli_test`, `OTP_DEMO_MODE=1`,
   `WHATSAPP_PROVIDER=log`, `CRON_SECRET`, `SESSION_SECRET`, `ADMIN_MOBILES`, the Razorpay
   **test** keys, `STORAGE_DRIVER=vercel-blob` + `BLOB_READ_WRITE_TOKEN`,
   `NEXT_PUBLIC_SITE_URL=https://maavuli-farms.vercel.app`. Redeploy.
3. Razorpay Dashboard (Test mode) → Webhooks → Add: URL
   `https://maavuli-farms.vercel.app/api/webhooks/razorpay`, the secret you put in
   `RAZORPAY_WEBHOOK_SECRET`, events `order.paid`, `payment.captured`, `payment.failed`,
   `refund.created`, `refund.processed`, `refund.failed`.
4. Check the job runs: Vercel → Settings → Cron Jobs lists `/api/cron/tick` every 5
   minutes. (Vercel refuses to deploy a cron more frequent than daily on a Hobby account,
   so the deploys succeeding means the plan allows it.) To run it at once instead of
   waiting for the next 5 minutes:
   ```sh
   curl -H "Authorization: Bearer $CRON_SECRET" https://maavuli-farms.vercel.app/api/cron/tick
   ```
5. When testing is done, section 8 switches it back.

### Setup B — your laptop

Tests without touching Vercel. In a browser everything runs on the real clock; the flows
that need the clock moved (cut-offs, day lock and close, a same-day rider round) are run
automatically by the e2e suite in section 7, which is what `MAAVULI_TIME_TRAVEL` is for.

1. `.env.local`: `MONGODB_DB=maavuli_dev`, `WHATSAPP_PROVIDER=log`, `MAAVULI_TIME_TRAVEL=1`,
   `CRON_SECRET`, the Razorpay test keys, your `ADMIN_MOBILES`. Leave `STORAGE_DRIVER` unset
   (photos are saved on disk).
2. `pnpm install`, then `pnpm db:init && pnpm db:seed-dev`, then `pnpm dev`.
3. Sign-in codes appear on screen for customers, riders and staff; an owner's code only in
   the terminal (`[otp] <mobile>: <code>`).
4. Nothing runs the 5-minute job on a laptop, and Razorpay's webhook cannot reach it. The
   payment still confirms through the checkout itself; run the job by hand when a test
   needs it:
   ```sh
   curl -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/tick
   ```

## 4. Mock data

The `98000…` numbers are made up. Use them only with `WHATSAPP_PROVIDER=log`: with real
WhatsApp on, a message to a made-up number could reach a real stranger. For section 6.10
use your own phones.

### Staff and riders (created by `db:seed-dev`)

| Who | Mobile | Role / zone |
|---|---|---|
| You | your number in `ADMIN_MOBILES` | Owner — everything |
| Dev Ops | 9800000011 | Ops |
| Dev Support | 9800000012 | Support |
| Ravi (dev rider) | 9800000001 | Rider, DEV Safilguda |
| Suresh (dev rider) | 9800000002 | Rider, DEV Malkajgiri |
| Lakshmi (dev rider) | 9800000003 | Rider, DEV Neredmet |

On a database without the seed, add them yourself: Admin → Staff, and Admin → Riders & zones.

### Zones (created by `db:seed-dev`; 1.8 km circles)

| Zone | Centre (lat, lng) |
|---|---|
| DEV Safilguda | 17.4735, 78.5468 |
| DEV Malkajgiri | 17.4508, 78.5358 |
| DEV Neredmet | 17.4870, 78.5320 |

### Customers

Prices: buffalo ₹95 and cow ₹115 per litre per day; 3 months −5%, 6 months −10%, 1 year −15%.
The review screen must show exactly the total in the last column.

| # | Name / mobile | Address (drop the pin at the coordinates) | Landmark / note | Plan | Expected total |
|---|---|---|---|---|---|
| C1 | Anitha Rao, 9800000101 | Flat 203, Sai Residency, Balram Nagar, Safilguda, Hyderabad 500047 — 17.4741, 78.5475 | Opp. the lake park / "Leave at the door, don't ring" | Cow ½ L, 1 month | ₹1,725.00 |
| C2 | Mohammed Irfan, 9800000102 | H.No. 3-4-12, Vinayak Nagar, Malkajgiri, Hyderabad 500047 — 17.4515, 78.5362 | Near the Hanuman temple | Buffalo 1 L, 3 months | ₹8,122.50 |
| C3 | Sravani Reddy, 9800000103 | Plot 58, Vayupuri, Neredmet, Hyderabad 500056 — 17.4876, 78.5327 | Green gate | Cow 1 L, 6 months | ₹18,630.00 |
| C4 | Venkat Naidu, 9800000104 | 12-45, Moula Ali Road, Safilguda, Hyderabad 500047 — 17.4729, 78.5460 | Ring twice | Buffalo ½ L, 1 year | ₹14,535.00 |
| C5 | Priya Sharma, 9800000105 | Gachibowli, Hyderabad 500032 — 17.4401, 78.3489 | Outside every zone | Any | Refused: not a delivery area |
| C6 | Kiran Kumar, 9800000106 | 7-1-9, Balram Nagar, Safilguda 500047 — 17.4738, 78.5480 | For failed payments | Cow 1 L, 1 month | ₹3,450.00 |

### Razorpay test payments (Test mode keys only; no money moves)

| Result wanted | Pay with |
|---|---|
| Success (UPI) | UPI ID `success@razorpay` |
| Failure (UPI) | UPI ID `failure@razorpay` |
| Success (card) | Visa `4100 2800 0000 1007`, any CVV, any future expiry; on the bank page enter an OTP of 4–10 digits |
| Card failure | same card, OTP of fewer than 4 digits — or `4100 2800 0006 0003` (declined), `4100 2800 0008 0001` (insufficient funds) |

In test mode, cancelling a UPI payment counts as a SUCCESS (Razorpay's behaviour); use the
failure UPI ID to test a failed payment.

## 5. How to sign in to each side

Everyone signs in with their mobile number and a 6-digit code (valid 5 minutes; 5 wrong
tries kill it; at most 3 codes per number per 15 minutes).

- **Customer** — `/account` or the last step of `/subscribe`. The code goes by WhatsApp;
  with `OTP_DEMO_MODE=1` (Vercel) or locally, it is shown on screen.
- **Admin** — open `/admin` and choose Sign in (it takes you to `/account?next=/admin`). Use
  an `ADMIN_MOBILES` number, or a staff number added in Admin → Staff. Without real
  WhatsApp, an owner's or staff member's code is written to the server log instead of the
  screen: Vercel → Project → Logs, search `[otp]`, the line reads `[otp] <mobile>: <code>`.
- **Rider** — open `/rider` on the phone and sign in with the rider's number from Admin →
  Riders & zones. Code: WhatsApp, or the server log as above.

Roles are checked on every request: removing a staff member or rider takes effect
immediately, and a customer who opens `/admin` is refused.

## 6. Test cases

Mark each row pass/fail and note what you saw. "Outbox" = Admin → Messages (with
`WHATSAPP_PROVIDER=log` every message is recorded there instead of sent).

### 6.1 Public pages and policies

| ID | Do | Expect |
|---|---|---|
| P1 | Open `/`, `/plans`, `/our-farm`, `/contact` on a phone and a laptop | Load without errors; footer shows "FSSAI Licence 13621034000380" |
| P2 | Open all four `/legal/…` pages | Each names "Maavuli Farm Milk, a partnership firm … No. 2308 of 2021" in Contact; Terms and Refunds say "Pause days included with each plan — 1 Month: 3 days, 3 Months: 20 days, 6 Months: 25 days, 1 Year: 30 days" |
| P3 | Admin → Settings: change photo retention from 60 to 45 days; reload `/legal/privacy` and `/legal/shipping` | Both now say 45 days. Change it back |
| P4 | Admin → Settings: move the cut-off; reload `/legal/refunds` | The cut-off time in the policy follows the setting |

### 6.2 Sign-up and payment (the funnel: where → address → milk → quantity → term → start date → review)

| ID | Do (mock data) | Expect |
|---|---|---|
| S1 | C1 end to end, pay with `success@razorpay` | Total ₹1,725.00 on review; after paying, the plan shows as active in `/account` with deliveries from the chosen start date; `order_confirmed` in the outbox |
| S2 | C2, C3, C4 the same way (one card, one UPI) | Totals exactly as in section 4; each plan active |
| S3 | C5: drop the pin in Gachibowli | Told this is not a delivery area; cannot continue to payment |
| S4 | C6, pay with `failure@razorpay` | Payment fails; no plan; you can retry and pay |
| S5 | C6 again, close the Razorpay window without paying; wait 30 minutes (and the job) | The order shows as expired in Admin → Orders; no plan |
| S6 | Start date: try more than 30 days ahead | Refused |
| S7 | Start date: after the 4:00 PM cut-off, try tomorrow | Tomorrow is not offered; the first open day is the day after |
| S8 | Double-tap Pay | Only one order is charged |

### 6.3 The customer's account (sign in as C1)

| ID | Do | Expect |
|---|---|---|
| A1 | Pause 2 future days | Both paused; plan end date moves 2 days later; pause days left drops by 2 |
| A2 | Pause more days than are left (C1 has 3 on a 1-month plan) | Refused: "Not enough pause days. You have N left…" |
| A3 | Unpause one day | Delivery is back; end date moves back one day |
| A4 | Pause tomorrow after the cut-off | Refused (the day is closed for changes) |
| A5 | Book extra milk for a day next week; pay | Extra shows on that day; after the cut-off it cannot be changed; more than 30 days ahead is refused |
| A6 | Change address and pin to 17.4745, 78.5470 | Saved; the rider sees the new pin from the next open day |
| A7 | Move the pin to Gachibowli | Refused: outside the delivery area |
| A8 | Turn WhatsApp updates off, then on; turn the daily delivery photo on | Saved; with updates off, nothing new appears in the outbox for C1 |
| A9 | Switch the missed-day choice from "extra day" to "credit" | Saved; used by test R5 |
| A10 | Report a problem about a delivery | A ticket appears for staff; C1 sees its status |
| A11 | Switch language to Telugu | Messages to C1 in the outbox are in Telugu |
| A12 | C2 cancels their plan after a few deliveries | Refund = amount paid − charged days × the standard daily price (charged = delivered, locked, and customer-side misses); shown before confirming; Admin → Refunds shows it; with the Razorpay webhook set, it ends as processed |
| A13 | Renew C1's plan from the account | Renewal starts the day after the current plan ends |
| A14 | Sign out, then press Back | The account page is not shown again |

### 6.4 Rider app (sign in as Ravi, 9800000001)

Deliveries appear on the day they are due: the first open day after the plan was bought
(tomorrow if bought before the 4:00 PM cut-off). Buy C1, C4 and C6 the day before you test
this section. The e2e suite covers the same-day path automatically.

| ID | Do | Expect |
|---|---|---|
| R1 | Open `/rider` on the due morning | Today's stops for DEV Safilguda (C1, C4, C6 if paid), in route order, with name, address, notes, phone and a map link |
| R2 | Mark C1 delivered: take the photo at the pin | Stop done; C1 sees the photo in their account; with the daily photo on, `delivered_today` in the outbox |
| R3 | Mark a stop delivered more than 150 m from its pin | Saved, but flagged for ops in Exceptions |
| R4 | C4: "couldn't deliver — no access" | Counted as delivered for C4 (not added back), shown in C4's history |
| R5 | C1 (credit chosen in A9): "couldn't deliver — out of stock" | C1 gets that day's value as credit (a customer on "extra day" gets a day added at the end instead) |
| R6 | Phone in airplane mode: mark a stop, then reconnect | Marked "saved on the phone"; syncs once online; recorded once only |
| R7 | Reload `/rider` while offline | The last saved round is shown |
| R8 | Sign in as Suresh (9800000002) | Sees only DEV Malkajgiri stops, never Ravi's |
| R9 | A customer mobile (C1) on `/rider` | Refused: not a rider |

### 6.5 Admin console (sign in as the owner)

| ID | Page | Do | Expect |
|---|---|---|---|
| D1 | Today | Watch while R2–R5 happen | Progress per rider updates |
| D2 | Tomorrow | Open before and after the cut-off | Before: counts can still change. After: the day is locked; the manifest matches what riders will get |
| D3 | Exceptions | Open after R3 and after the delivery window ends with a stop left unmarked | Both listed; set an outcome for the unmarked one |
| D4 | Riders & zones | Draw a new zone; add a rider; switch a rider off | The zone decides who can sign up; a switched-off rider can no longer open `/rider` |
| D5 | Routes | Re-optimise a rider's route | New order; with a Google key it uses Google, without it the local order |
| D6 | Disruptions | "Rain in DEV Neredmet" for tomorrow: preview, then apply | Preview lists C3; after applying, C3's day is our miss (extra day or credit) and C3 is messaged |
| D7 | Customers | Open C2; give ₹150 goodwill credit; pause a day for them | Credit and pause appear in C2's account and timeline |
| D8 | Orders / Plans | Find C1–C6 | Paid, failed and expired orders as tested; plans with correct end dates |
| D9 | Refunds | Open C2's refund | Amount and status as in A12; manual refund possible if Razorpay cannot refund |
| D10 | Messages | Open the outbox | Every message from the tests, with its status |
| D11 | Staff | Add, then remove, a support member | The removed number loses `/admin` on the next click |
| D12 | Settings | Change cut-off, delivery window, unpaid-order expiry, photo retention | Saved; invalid values (e.g. photo retention 400) refused with a reason |

### 6.6 Staff permissions

| ID | Do | Expect |
|---|---|---|
| X1 | Dev Support (9800000012) gives ₹150 goodwill | Allowed |
| X2 | Dev Support gives ₹500 | Refused (support limit ₹200 per entry; ops ₹1,000; owner ₹10,000) |
| X3 | Dev Support opens Admin → Staff, then tries to save a change in Settings | Staff: not allowed. Settings: can be viewed, saving is refused |
| X4 | Dev Ops (9800000011) gives ₹800 | Allowed |
| X5 | Dev Ops tries to save a change in Settings, or to add staff | Refused: only an owner can |

### 6.7 The 5-minute job (needs CRON_SECRET)

| ID | Check | Expect |
|---|---|---|
| J1 | `curl https://maavuli-farms.vercel.app/api/cron/tick` without the header | 401 Unauthorised (not the "not configured" 503 seen today) |
| J2 | S5 | The unpaid order expires after 30 minutes |
| J3 | After the cut-off | Tomorrow is locked (D2) |
| J4 | After the delivery window | Unmarked stops go to Exceptions |
| J5 | A plan ending in 7, 3 and 1 days | Renewal reminders in the outbox |
| J6 | Any message in the outbox | Moves from queued to sent (or "logged" with `log`) |

### 6.8 Razorpay webhook

| ID | Do | Expect |
|---|---|---|
| W1 | After S1, Razorpay Dashboard → Webhooks → the webhook's deliveries | `payment.captured` / `order.paid` answered 200 |
| W2 | After A12 | `refund.processed` answered 200; Admin → Refunds shows processed |

### 6.9 Privacy and offline

| ID | Do | Expect |
|---|---|---|
| V1 | Chrome → DevTools → Application → Cache Storage, after visiting `/account` | Only `mv-v2-…` caches; no `/account`, `/admin` or `/subscribe` entry |
| V2 | Photo link from C1's account, opened in a private window | Refused (photos are private) |
| V3 | Open another customer's photo address while signed in as C1 | Refused |

### 6.10 Real WhatsApp (only after Meta setup; your own phones only)

| ID | Do | Expect |
|---|---|---|
| M1 | Sign in with your phone | Code arrives on WhatsApp; nothing on screen |
| M2 | Reply STOP to the business number | Updates turn off (Admin → Customers shows opted out) |
| M3 | Tap "Report a problem" on a Maavuli message | A ticket opens for staff |
| M4 | Tap "Pause tomorrow" | A reply with a link to the account; nothing is paused until you do it there |

## 7. Automated checks (laptop)

```sh
pnpm typecheck                        # 0 errors expected
pnpm test:unit                        # 10 suites, a few seconds, no database

# 15 database suites in scripts/it (b1-lifecycle … orch-state). Each refuses to run
# unless MONGODB_DB starts with maavuli_it_, so it can never touch real data:
MONGODB_DB=maavuli_it_b1 pnpm db:init
MONGODB_DB=maavuli_it_b1 pnpm it scripts/it/b1-lifecycle.ts

# The whole platform over HTTP, with the clock moved for cut-offs and day close.
# Sets up its own database (indexes + seed) and starts its own `next dev` on
# 127.0.0.1:3310 — close other heavy apps first.
MONGODB_DB=maavuli_e2e pnpm run e2e
```

## 8. After testing — before real customers

1. Vercel: set `MONGODB_DB=maavuli` again, delete `OTP_DEMO_MODE`, redeploy.
2. WhatsApp: `WHATSAPP_PROVIDER=meta` with approved templates (sign-in needs the
   authentication template), and the webhook `https://…/api/webhooks/whatsapp` with
   `WHATSAPP_VERIFY_TOKEN`.
3. Real zones and riders in the real database (Admin → Riders & zones).
4. Razorpay live keys only after the policies are final (docs/CLIENT-QUESTIONS.md).
5. `NEXT_PUBLIC_SITE_URL` = the real domain once it points here.

## 9. Not testable yet

- SMS sign-in codes (the SMS provider is not built; WhatsApp is the channel).
- Real WhatsApp delivery until Meta business verification and template approval.
- Live payments (Razorpay live keys wait on the final policies).
- The real delivery area, riders and farm start point (client questions 3–5).
