// scripts/roll-deliveries.mjs — RETIRED.
//
// This job used to mark every still-scheduled delivery from yesterday as
// "delivered" — i.e. it assumed milk arrived instead of recording that it did, so a
// missed doorstep could never exist and the missed-delivery credit in the refund
// policy could never happen.
//
// The platform replaces it with the scheduled tick (/api/cron/tick, every 5 minutes,
// see vercel.json and lib/jobs.ts): riders mark each stop delivered with a photo, the
// day closes at the configured time (unmarked → unconfirmed for ops), and anything
// still unconfirmed 24 hours later is treated as OUR miss and compensated.
console.error(
  'roll-deliveries is retired: deliveries are now confirmed by riders and closed by the ' +
    'scheduled tick (/api/cron/tick). Nothing was changed.',
);
process.exit(1);
