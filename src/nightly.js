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
const { Pool } = require("pg");

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes("--" + n);
const fmt = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d).replace(/-/g, "");
const addDays = (yyyymmdd, n) => { const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) + n * 864e5); return d.toISOString().slice(0, 10).replace(/-/g, ""); };
const DATE = arg("date", fmt(new Date(Date.now() - 864e5)));
const BACKPAD = Number(arg("backpad", 2));
const dow = new Date(Date.UTC(+DATE.slice(0, 4), +DATE.slice(4, 6) - 1, +DATE.slice(6, 8))).getUTCDay();
const DEEP = flag("deep") || (dow === 0 && !flag("no-deep")); // Sunday
const SRC = __dirname;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  await pool.query(`CREATE TABLE IF NOT EXISTS raw.pipeline_runs (
    id uuid PRIMARY KEY, business_date int NOT NULL, mode text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    status text NOT NULL DEFAULT 'running', stages jsonb NOT NULL DEFAULT '[]', error text)`);
  // one nightly run at a time
  const lock = await pool.query("SELECT pg_try_advisory_lock(727001) ok");
  if (!lock.rows[0].ok) { console.error("another nightly run holds the lock - exiting"); process.exit(3); }
  const id = crypto.randomUUID(), stages = [];
  await pool.query("INSERT INTO raw.pipeline_runs(id,business_date,mode) VALUES ($1,$2,$3)", [id, +DATE, `${flag("skip-pull") ? "rebuild" : "pull"}${DEEP ? "+deep" : ""} backpad=${BACKPAD}`]);
  const save = (status, error) => pool.query("UPDATE raw.pipeline_runs SET stages=$2::jsonb, status=$3, error=$4, finished_at=CASE WHEN $3='running' THEN NULL ELSE now() END WHERE id=$1", [id, JSON.stringify(stages), status, error || null]);

  const run = async (name, script, args = [], opts = {}) => {
    const t0 = Date.now();
    console.log(`\n=== ${name} ===`);
    const r = spawnSync(process.execPath, [path.join(SRC, script), ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: path.join(SRC, "..") });
    const tail = (r.stdout || "").split("\n").filter((l) => l.trim() && !/sslmode|pg-connection|libpq|prepare for|trace-warn|SECURITY|^In the|^To prepare|^- If you|^See https/.test(l)).slice(-12).join("\n");
    console.log(tail || "(no output)");
    if (r.stderr && r.status !== 0) console.error((r.stderr || "").split("\n").filter((l) => !/sslmode|pg-connection|libpq/.test(l)).slice(-8).join("\n"));
    const st = { stage: name, ok: r.status === 0, seconds: Math.round((Date.now() - t0) / 1000) };
    stages.push(st); await save("running");
    if (r.status !== 0 && !opts.soft) { await save("failed", `${name} failed (exit ${r.status})`); throw new Error(`${name} failed`); }
    return r.status === 0;
  };

  try {
    if (!flag("skip-pull")) {
      // self-healing: re-pull the days before the target too, so a day that failed to land is retried automatically
      for (let k = BACKPAD; k >= 0; k--) await run(`pull ${addDays(DATE, -k)}`, "pull.js", ["--date", addDays(DATE, -k)]);
      if (DEEP) await run("pull deep (30-day modified window)", "pull.js", ["--date", DATE, "--pad-days", "30"], { soft: true });
    }
    await run("build input", "build_input.js");
    await run("build drv", "build_drv.js");
    await run("build semantic", "build_semantic.js");
    await run("build output", "build_output.js");
    await run("reconciliation", "reconcile.js", ["--date", DATE]);
    await run("reports", "build_reports.js", ["--date", DATE, ...(process.env.REPORT_DIR ? ["--out", process.env.REPORT_DIR] : [])]);
    await save("success");
    console.log(`\nNIGHTLY OK for ${DATE}`);
  } catch (e) {
    console.error(`\nNIGHTLY FAILED for ${DATE}: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    await pool.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
