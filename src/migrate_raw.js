// One-off migration of the SOR (raw) schema from the old Neon project into the project in DATABASE_URL.
// READ-ONLY on the source. Refuses to run if the target raw tables already contain rows (unless --force).
//   node src/migrate_raw.js
// Source: DATABASE_URL_OLD_PROJECT_UNPOOLED   Target: DATABASE_URL
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SRC = process.env.DATABASE_URL_OLD_PROJECT_UNPOOLED || process.env.DATABASE_URL_OLD_PROJECT;
const DST = process.env.DATABASE_URL;
if (!SRC || !DST) { console.error("need DATABASE_URL_OLD_PROJECT_UNPOOLED and DATABASE_URL"); process.exit(1); }
if (new URL(SRC).hostname.replace("-pooler", "") === new URL(DST).hostname.replace("-pooler", "")) { console.error("source and target are the same server - refusing"); process.exit(1); }

const TABLES = [ // copy order respects foreign keys
  { name: "tenant_locations", key: "location_guid" },
  { name: "pull_runs", key: "run_id" },
  { name: "api_responses", key: "id", batch: 40 },
  { name: "toast_orders", key: "order_guid", batch: 200 },
  { name: "pipeline_runs", key: "id" },
];

(async () => {
  const src = new Pool({ connectionString: SRC, max: 1 });
  const dst = new Pool({ connectionString: DST, max: 1 });
  console.log("source:", (await src.query("select current_database() d")).rows[0].d, "-> target:", (await dst.query("select current_database() d")).rows[0].d);

  // schema on the target (same DDL the pipeline uses)
  await dst.query(fs.readFileSync(path.join(__dirname, "../sql/001_raw.sql"), "utf8"));
  await dst.query(`CREATE TABLE IF NOT EXISTS raw.pipeline_runs (
    id uuid PRIMARY KEY, business_date int NOT NULL, mode text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    status text NOT NULL DEFAULT 'running', stages jsonb NOT NULL DEFAULT '[]', error text)`);
  if (process.argv.includes("--reset-target")) { // empties ONLY the target's raw tables so the copy can be redone exactly; the source is never written
    await dst.query("TRUNCATE raw.api_responses, raw.toast_orders, raw.pipeline_runs, raw.pull_runs, raw.tenant_locations");
    console.log("target raw tables emptied (source untouched)");
  }
  if (!process.argv.includes("--force")) {
    for (const t of TABLES) {
      const n = +(await dst.query(`select count(*) n from raw.${t.name}`)).rows[0].n;
      if (n > 0) { console.error(`target raw.${t.name} already has ${n} rows - refusing (use --force only if you mean it)`); process.exit(1); }
    }
  }

  for (const t of TABLES) {
    const cols = (await src.query(`select column_name, data_type from information_schema.columns where table_schema='raw' and table_name=$1 order by ordinal_position`, [t.name])).rows;
    const names = cols.map((c) => `"${c.column_name}"`).join(", ");
    const total = +(await src.query(`select count(*) n from raw.${t.name}`)).rows[0].n;
    const batch = t.batch || 500;
    let done = 0, lastKey = null;
    // keyset pagination on the primary key; jsonb sent as text and cast back
    while (done < total) {
      const sel = cols.map((c) => (c.data_type === "jsonb" || c.data_type === "ARRAY" || c.data_type.startsWith("timestamp") ? `"${c.column_name}"::text` : `"${c.column_name}"`)).join(", ");
      const rows = (await src.query(`select ${sel} from raw.${t.name} ${lastKey === null ? "" : `where "${t.key}" > $1`} order by "${t.key}" limit ${batch}`, lastKey === null ? [] : [lastKey])).rows;
      if (!rows.length) break;
      const params = [];
      const values = rows.map((r) => "(" + cols.map((c) => {
        params.push(r[c.column_name]);
        const cast = c.data_type === "jsonb" ? "::jsonb" : c.data_type === "ARRAY" ? "::text[]" : c.data_type === "timestamp with time zone" ? "::timestamptz" : c.data_type === "timestamp without time zone" ? "::timestamp" : "";
        return `$${params.length}${cast}`;
      }).join(",") + ")").join(",");
      await dst.query(`insert into raw.${t.name} (${names}) values ${values} on conflict do nothing`, params);
      done += rows.length;
      lastKey = rows[rows.length - 1][t.key];
      if (typeof lastKey === "object" && lastKey !== null) lastKey = String(lastKey);
    }
    console.log(`copied raw.${t.name}: ${done}/${total}`);
  }
  // keep the bigserial moving after the copied ids
  await dst.query(`select setval(pg_get_serial_sequence('raw.api_responses','id'), coalesce((select max(id) from raw.api_responses),1))`);

  // verification: counts + content fingerprints on both sides
  const fp = {
    tenant_locations: `select count(*) n, md5(string_agg(location_guid::text||location_name||tenant, ',' order by location_guid)) h from raw.tenant_locations`,
    pull_runs: `select count(*) n, md5(string_agg(run_id::text||status||coalesce(orders_landed,0)::text||started_at::text||coalesce(finished_at::text,''), ',' order by run_id)) h from raw.pull_runs`,
    api_responses: `select count(*) n, md5(string_agg(id::text||endpoint||coalesce(http_status,0)::text||fetched_at::text||md5(payload::text), ',' order by id)) h from raw.api_responses`,
    toast_orders: `select count(*) n, md5(string_agg(order_guid::text||coalesce(modified_date::text,'')||fetched_at::text||md5(payload::text), ',' order by order_guid)) h from raw.toast_orders`,
    pipeline_runs: `select count(*) n, md5(string_agg(id::text||status||started_at::text, ',' order by id)) h from raw.pipeline_runs`,
  };
  let ok = true;
  const out = [];
  for (const [t, sql] of Object.entries(fp)) {
    const a = (await src.query(sql)).rows[0], b = (await dst.query(sql)).rows[0];
    const same = a.n === b.n && a.h === b.h; ok = ok && same;
    out.push({ table: "raw." + t, source_rows: +a.n, target_rows: +b.n, content_identical: same ? "YES" : "NO" });
  }
  console.table(out);
  console.log(ok ? "MIGRATION OF raw VERIFIED: row counts and content checksums are identical." : "MISMATCH - do not delete the old project.");
  await src.end(); await dst.end();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
