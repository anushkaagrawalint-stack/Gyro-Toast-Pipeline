// Retention (approved 2026-11-09): order JSON in the API log is kept 30 days, then removed. The call record (date, counts,
// status, md5) stays, and raw.toast_orders keeps the latest copy of every order permanently.
//   node src/prune_raw.js [--days 30]
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");
const i = process.argv.indexOf("--days"), DAYS = i > -1 ? Number(process.argv[i + 1]) : 30;
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const r = await p.query(`UPDATE raw.api_responses SET payload = NULL, payload_pruned_at = now()
     WHERE endpoint LIKE '/orders/%' AND payload IS NOT NULL AND fetched_at < now() - make_interval(days => $1)`, [DAYS]);
  console.log(`pruned order JSON from ${r.rowCount} API log rows older than ${DAYS} days`);
  await p.end();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
