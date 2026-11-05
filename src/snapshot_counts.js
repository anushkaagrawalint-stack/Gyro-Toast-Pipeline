// Snapshot of raw-layer counts (before/after an incremental load). Usage: node src/snapshot_counts.js [label]
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const r = (await p.query(`select now() at time zone 'UTC' as at_utc,
    (select count(*) from raw.toast_orders) orders, (select count(*) from raw.api_responses) api_calls, (select count(*) from raw.pull_runs) pull_runs,
    (select count(*) from raw.pipeline_runs) pipeline_runs, (select max(fetched_at) from raw.toast_orders) last_fetch,
    (select count(*) from raw.toast_orders where business_date=20261104) orders_4nov, (select count(*) from raw.toast_orders where business_date=20261105) orders_5nov,
    (select count(*) from raw.toast_orders where fetched_at > now() - interval '30 minutes') fetched_last_30min`)).rows[0];
  console.log(process.argv[2] || "snapshot", JSON.stringify(r));
  await p.end();
})();
