// Scheduler gate (GitHub Actions): run unless yesterday's business date (store time) was already loaded successfully.
// GitHub can start scheduled runs hours late; this makes a late run still do the work, and later slots skip themselves.
// Prints run=true|false (and appends it to $GITHUB_OUTPUT when present).
require("dotenv").config({ quiet: true });
const fs = require("fs");
const { Pool } = require("pg");
(async () => {
  const y = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(Date.now() - 864e5)).replace(/-/g, "");
  const p = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const done = (await p.query(`SELECT 1 FROM raw.pipeline_runs WHERE business_date=$1 AND status='success' AND mode NOT LIKE 'rebuild%' LIMIT 1`, [+y])).rowCount > 0;
  await p.end();
  const line = `run=${!done}`;
  console.log(`${line}  (yesterday ${y} ${done ? "already loaded" : "not loaded yet"})`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line + "\n");
})().catch((e) => { console.error("gate check failed, running anyway:", e.message); if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "run=true\n"); });
