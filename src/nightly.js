// Nightly pipeline: pull (self-healing window) -> input -> drv -> semantic -> output -> reconciliation -> reports.
//   node src/nightly.js                      yesterday (America/Chicago) with the self-healing back-pad (default 2 days)
//   node src/nightly.js --date 20261103      a specific business date (also re-pulls the 2 days before it)
//   node src/nightly.js --backpad 0          only the date itself
//   node src/nightly.js --deep               also re-pull a 30-day modified window (late voids / catering cancellations); automatic on Sundays
//   node src/nightly.js --skip-pull          rebuild layers from what is already in SOR
require("dotenv").config({ quiet: true });
const { spawnSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes("--" + n);
const fmt = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d).replace(/-/g, "");
const addDays = (yyyymmdd, n) => { const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) + n * 864e5); return d.toISOString().slice(0, 10).replace(/-/g, ""); };
const DATE = arg("date", fmt(new Date(Date.now() - 864e5)));
const BACKPAD = Number(arg("backpad", 2));
const dow = new Date(Date.UTC(+DATE.slice(0, 4), +DATE.slice(4, 6) - 1, +DATE.slice(6, 8))).getUTCDay();
const DEEP = flag("deep") || (dow === 0 && !flag("no-deep")); // Sunday
const FROM = arg("from");
const SRC = __dirname;
// fiscal periods (schema/fiscal_calendar.csv) are the backfill chunks; dates outside the calendar fall back to 28-day chunks
const FISCAL = require("fs").readFileSync(path.join(__dirname, "../schema/fiscal_calendar.csv"), "utf8").trim().split("\n").slice(1)
  .map((l) => l.split(",")).map((r) => ({ s: r[2].replace(/-/g, ""), e: r[3].replace(/-/g, "") }));
function chunks(from, to) {
  const out = [];
  for (let d = from; d <= to; ) {
    const p = FISCAL.find((x) => d >= x.s && d <= x.e);
    let e = p ? p.e : addDays(d, 27);
    if (e > to) e = to;
    out.push([d, e]); d = addDays(e, 1);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNetErr = (e) => /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|Connection terminated|connection timeout|socket|Client has encountered a connection error|not queryable/i.test(`${e.code || ""} ${e.message || ""}`);

// The run log + the one-run-at-a-time advisory lock live on one direct connection. A network blip can drop it
// (a long backfill will see some), so q() reconnects, takes the lock again, and retries - instead of killing the run.
let db = null, LOCKED = false;
async function connect() {
  const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 30000 });
  c.on("error", (e) => { console.error(`(pipeline log connection dropped: ${e.message})`); if (db === c) db = null; });
  await c.connect();
  if (LOCKED) {
    // the old session's lock is released once the server notices it died; wait for that, but never run alongside another run
    for (let i = 1; ; i++) {
      if ((await c.query("SELECT pg_try_advisory_lock(727001) ok")).rows[0].ok) break;
      if (i >= 12) { await c.end().catch(() => {}); throw Object.assign(new Error("could not re-take the run lock (another run may be active)"), { fatal: true }); }
      await sleep(15000);
    }
  }
  return c;
}
async function q(sql, params) {
  for (let i = 1; ; i++) {
    try {
      if (!db) db = await connect();
      return await db.query(sql, params);
    } catch (e) {
      if (e.fatal || !isNetErr(e) || i >= 8) throw e;
      console.error(`(database unreachable: ${e.message} - retry ${i}/7 in ${15 * i}s)`);
      if (db) db.end().catch(() => {});
      db = null;
      await sleep(15000 * i);
    }
  }
}

async function main() {
  await q(`CREATE TABLE IF NOT EXISTS raw.pipeline_runs (
    id uuid PRIMARY KEY, business_date int NOT NULL, mode text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    status text NOT NULL DEFAULT 'running', stages jsonb NOT NULL DEFAULT '[]', error text)`);
  // one nightly run at a time
  const lock = await q("SELECT pg_try_advisory_lock(727001) ok");
  if (!lock.rows[0].ok) { console.error("another nightly run holds the lock - exiting"); process.exit(3); }
  LOCKED = true;
  // we hold the lock, so any run still marked 'running' died without finishing
  await q("UPDATE raw.pipeline_runs SET status='abandoned', finished_at=now(), error=coalesce(error,'process died before finishing') WHERE status='running'");
  const id = crypto.randomUUID(), stages = [];
  await q("INSERT INTO raw.pipeline_runs(id,business_date,mode) VALUES ($1,$2,$3)", [id, +DATE, FROM ? `backfill ${FROM}-${DATE}` : `${flag("skip-pull") ? "rebuild" : "pull"}${DEEP ? "+deep" : ""} backpad=${BACKPAD}`]);
  const save = (status, error) => q("UPDATE raw.pipeline_runs SET stages=$2::jsonb, status=$3, error=$4, finished_at=CASE WHEN $3='running' THEN NULL ELSE now() END WHERE id=$1", [id, JSON.stringify(stages), status, error || null]);

  // every stage is idempotent, so a failed stage (network blip, Toast hiccup) is retried before the run gives up
  const run = async (name, script, args = [], opts = {}) => {
    const t0 = Date.now();
    const retries = opts.retries ?? 2;
    console.log(`\n=== ${name} ===`);
    let r;
    for (let attempt = 0; ; attempt++) {
      r = spawnSync(process.execPath, [path.join(SRC, script), ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: path.join(SRC, "..") });
      const tail = (r.stdout || "").split("\n").filter((l) => l.trim() && !/sslmode|pg-connection|libpq|prepare for|trace-warn|SECURITY|^In the|^To prepare|^- If you|^See https/.test(l)).slice(-12).join("\n");
      console.log(tail || "(no output)");
      if (r.stderr && r.status !== 0) console.error((r.stderr || "").split("\n").filter((l) => !/sslmode|pg-connection|libpq/.test(l)).slice(-8).join("\n"));
      if (r.status === 0 || attempt >= retries) break;
      console.log(`--- ${name} failed (exit ${r.status}); retry ${attempt + 1}/${retries} in ${60 * (attempt + 1)}s`);
      await sleep(60000 * (attempt + 1));
    }
    const st = { stage: name, ok: r.status === 0, seconds: Math.round((Date.now() - t0) / 1000) };
    stages.push(st); await save("running");
    if (r.status !== 0 && !opts.soft) { await save("failed", `${name} failed (exit ${r.status})`); throw new Error(`${name} failed`); }
    return r.status === 0;
  };
  // backfill resume: a day that already has a complete pull is not pulled again (use --repull to force)
  const pulledOk = async (d) => !flag("repull") && (await q("SELECT 1 FROM raw.pull_runs WHERE business_date=$1 AND status='success' LIMIT 1", [+d])).rowCount > 0;

  try {
    const days = (a, b) => { const r = []; for (let d = a; d <= b; d = addDays(d, 1)) r.push(d); return r; };
    if (FROM) {
      // ---- backfill: one fiscal period at a time (bounded memory and time), then restore the normal work window
      for (const [cs, ce] of chunks(FROM, DATE)) {
        if (!flag("skip-pull")) for (const d of days(cs, ce)) {
          if (d !== DATE && (await pulledOk(d))) { console.log(`pull ${d}: already pulled - skipped`); continue; }
          await run(`pull ${d}${d === DATE ? " (full)" : " (lean)"}`, "pull.js", ["--date", d, ...(d === DATE ? [] : ["--lean"])]);
        }
        await run(`build input ${cs}-${ce}`, "build_input.js", ["--from", cs, "--to", ce]);
        await run(`build drv ${cs}-${ce}`, "build_drv.js");
        await run(`build semantic ${cs}-${ce}`, "build_semantic.js");
      }
      await run("build input (work window)", "build_input.js", ["--full"]);
      await run("build drv (work window)", "build_drv.js");
      await run("build semantic (work window)", "build_semantic.js");
      await run("build output", "build_output.js");
      let bad = 0;
      for (const d of days(FROM, DATE)) if (!(await run(`reconciliation ${d}`, "reconcile.js", ["--date", d], { soft: true, retries: 1 }))) bad++;
      if (bad) { await save("failed", `${bad} day(s) failed reconciliation`); throw new Error(`${bad} day(s) failed reconciliation`); }
    } else {
      if (!flag("skip-pull")) {
        // self-healing: re-pull the days before the target too, so a day that failed to land is retried automatically
        for (let k = BACKPAD; k >= 0; k--) await run(`pull ${addDays(DATE, -k)}`, "pull.js", ["--date", addDays(DATE, -k)]);
        if (DEEP) await run("pull deep (30-day modified window)", "pull.js", ["--date", DATE, "--pad-days", "30"], { soft: true });
      }
      await run("build input", "build_input.js", flag("skip-pull") ? ["--full"] : []);
      await run("build drv", "build_drv.js");
      await run("build semantic", "build_semantic.js");
      await run("build output", "build_output.js");
      await run("reconciliation", "reconcile.js", ["--date", DATE], { retries: 1 });
    }
    await run("prune API log (order JSON older than 30 days)", "prune_raw.js", [], { soft: true });
    await run("reports", "build_reports.js", ["--date", DATE, ...(process.env.REPORT_DIR ? ["--out", process.env.REPORT_DIR] : [])]);
    await save("success");
    console.log(`\nNIGHTLY OK for ${DATE}`);
  } catch (e) {
    console.error(`\nNIGHTLY FAILED for ${DATE}: ${e.message}`);
    await save("failed", e.message).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (db) { await db.query("SELECT pg_advisory_unlock(727001)").catch(() => {}); await db.end().catch(() => {}); }
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
