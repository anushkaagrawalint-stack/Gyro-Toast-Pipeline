// Quick connectivity / readiness check for the database in DATABASE_URL (prints no secrets).
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const r = (await p.query(`SELECT current_database() db, current_user usr, current_setting('server_version') ver, now() now`)).rows[0];
  console.log(`connected: db=${r.db} role=${r.usr} postgres=${r.ver}`);
  const major = parseInt(r.ver, 10);
  console.log(`postgres >= 15 (needed for NULLS NOT DISTINCT): ${major >= 15 ? "yes" : "NO"}`);
  const sch = (await p.query(`SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast') AND schema_name NOT LIKE 'pg_temp%' ORDER BY 1`)).rows.map((x) => x.schema_name);
  console.log("existing schemas:", sch.join(", ") || "(none)");
  const t = (await p.query(`SELECT count(*) n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')`)).rows[0].n;
  console.log("existing tables:", t);
  await p.query("CREATE SCHEMA IF NOT EXISTS _probe; CREATE TABLE _probe.t(x int); INSERT INTO _probe.t VALUES (1); DROP SCHEMA _probe CASCADE;");
  console.log("can create schemas/tables: yes");
  const lock = (await p.query("SELECT pg_try_advisory_lock(727001) ok, pg_advisory_unlock(727001) un")).rows[0];
  console.log("advisory lock (direct connection):", lock.ok && lock.un ? "works" : "FAILED");
  await p.end();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
