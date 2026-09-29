# Maavuli platform — questions for the client

Everything below is already built with the default shown, so the platform works
today; each answer either confirms the default or is a small change. Items marked
**Needed before launch** block going live.

## A. Needed before launch (accounts, documents, data)

1. **FSSAI licence number and GSTIN** — shown in the footer and needed for Meta's
   business verification (WhatsApp).
2. **WhatsApp on the existing farm number** — choose a WhatsApp provider that
   supports "coexistence" (keeps the WhatsApp Business app on the phone), complete
   Meta business verification, and get the message templates approved.
3. **Real delivery zones** — draw the actual service area in Admin → Riders &
   zones (today only test zones exist). Nobody outside a zone can subscribe.
4. **Riders and staff** — each rider's name and the mobile number they will sign in
   with; each staff member's name, number and role (owner / ops / support).
5. **Farm location** (where rider routes start) — or each rider's start point.
6. **Accounts to create** (we can walk you through each): Vercel Pro, a Vercel Blob
   store set to PRIVATE (delivery photos), Google Maps keys (a server key for route
   optimisation and a browser key for the address map) with billing enabled,
   Razorpay live keys, and the site's domain.
7. **Telugu wording** — all Telugu text (WhatsApp messages, rider app) is a machine
   draft and must be checked by a native speaker before Meta approval.

## B. Money and policy

8. **Cancellation refund** — built exactly as the published policy: charged days ×
   standard 1-month rate, the rest refunded (₹35,190 year plan cancelled after 60
   days → ₹28,290 back; ₹0 from day 306). Confirm.
9. **Days the customer misses** (not home, refused, asked to skip) — counted as
   charged days at cancellation; days WE miss are never charged. Confirm.
10. **A day we miss** — default: one day added to the end of the plan; the customer
    can switch to credit (at the price they paid) in their account. Confirm.
11. **Refunds on payments older than 6 months** — Razorpay cannot refund them, so we
    ask the customer for a UPI id and pay by UPI transfer. Confirm this process.
12. **Late payment after the credit was spent** — rare: an order expires, the
    customer spends that credit elsewhere, then the payment arrives. The plan
    activates and the shortfall is logged. Chase the difference or write it off?
13. **Goodwill credit limits per entry** — support ₹200, ops ₹1,000, owner ₹10,000.
    Confirm or change.

## C. Daily operations (all editable later in Admin → Settings)

14. **Cut-off** — changes for a day close at 4:00 PM the day before. Confirm.
15. **Delivery window** — 5:30–8:00 AM; the day closes (unmarked stops go to ops) at
    10:00 AM. Confirm.
16. **Pause allowance** — 1 month: 3 days, 3 months: 20, 6 months: 25, 1 year: 30.
17. **Photo proof** — kept 60 days; a "delivered" tap more than 150 m from the pin is
    flagged for ops. Confirm both.
18. **Unpaid checkouts** expire after 30 minutes. **Renewal reminders** go 7, 3 and 1
    days before a plan ends. Confirm.
19. **Bottles** — glass with a deposit and returns, or pouches? (Deposit tracking is
    not built; say if needed.)
20. **Rider pay** — per drop or salary? If per drop, the delivery records can double
    as the payout sheet.
21. **Rider load sheet** — the printed sheet leaves out customers' phone numbers (the
    rider app has them). Keep it that way?

## D. Customer choices

22. **Extra milk** — can be booked up to 30 days ahead, and may be the other milk
    (buffalo extra on a cow plan). Allow both?
23. **Renewal** — may the customer switch milk type when renewing? Should "Renew" also
    show for a few days after a plan has ended (today: only while 10 or fewer days
    remain)?
24. **Reporting a problem** — how far back may a customer report a delivery (today:
    any past delivery)? Should they be able to attach a photo?
25. **Outside the delivery area** — today they can email or call. Do you want a
    waitlist we store and contact when the area opens?
26. **WhatsApp consent wording** — lists order confirmation, the first-delivery
    notice, missed deliveries and refunds. Add renewal reminders? Confirm the
    buttons customers can tap in WhatsApp: Stop, Report a problem, Talk to us,
    Pause tomorrow.

## E. Staff permissions

27. **Support staff** today can view everything, give small goodwill credits and turn
    a customer's WhatsApp off. Should they also resolve exceptions (mark a delivery
    done after a customer call) and pause dates on a customer's behalf?
28. **Abandoned checkouts call list** — orders started but not paid in the last 30
    days. Include failed payments too?

## F. From the final checks (built with the default shown; say if you want it changed)

29. **Missed-day credit and cancellation** — as published, a day we miss is not
    charged at cancellation, and unspent credit from missed days is also refunded.
    For a customer who chose credit instead of an extra day, that day comes back
    twice (1 L cow year plan: ₹115 not charged, plus ₹96 of credit refunded). Built
    as published for now. We suggest counting a credited missed day as used at the
    price paid, so it comes back once. Which do you want?
30. **A day found missed after cancelling** — a day that was already on the route
    when the customer cancelled is charged (₹115). If it later turns out we missed
    it, we give back ₹115 as credit (what was charged), not the lower price paid.
    Confirm.
31. **Renewal already paid, current plan cancelled** — the paid renewal now starts
    straight away, from the day the cancelled plan stops, so there is no gap in
    milk. Or should cancelling a plan also cancel and refund its renewal?
32. **Renewal paid twice by mistake** — the second one runs after the first (two
    terms back to back), and ops can cancel one for a refund under the normal
    policy. Or should a second renewal be refunded automatically?
33. **Goodwill limit per day** — on top of the per-entry limits (item 13), one
    customer can receive at most that limit in total from staff in 24 hours
    (support ₹200, ops ₹1,000, owner ₹10,000), counting all staff. Confirm.
34. **Corrections to past deliveries** — riders can change only today's deliveries
    in the app; anything from an earlier day is corrected by ops in the admin
    console. Confirm.
35. **Delivery photo links in WhatsApp** — the link in the "delivered" message works
    for 24 hours; the photo stays in the customer's account for 60 days. Confirm.
