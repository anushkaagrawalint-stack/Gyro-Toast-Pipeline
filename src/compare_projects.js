// Compares every table of the layers raw/input/drv/sem/output between the OLD project and the project in DATABASE_URL:
// row count + a content checksum (rows sorted as text). READ-ONLY on both sides.
//   node src/compare_projects.js
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");
const SCHEMAS = ["raw", "input", "drv", "sem", "output"];
(async () => {
  const a = new Pool({ connectionString: process.env.DATABASE_URL_OLD_PROJECT_UNPOOLED, max: 1 });
  const b = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const tables = async (p) => (await p.query(`select table_schema s, table_name t from information_schema.tables where table_schema = any($1) and table_type='BASE TABLE' and table_name not like '\\_%' order by 1,2`, [SCHEMAS])).rows.map((r) => `${r.s}.${r.t}`);
  const ta = await tables(a), tb = await tables(b);
  const all = [...new Set([...ta, ...tb])].filter((t) => t !== "raw.pipeline_runs").sort(); // run log differs by design (the new project logs its own rebuild)
  const bad = [], per = {};
  for (const t of all) {
    const [s] = t.split(".");
    const sql = `select count(*) n, coalesce(md5(string_agg(x::text, '' order by x::text)), '') h from ${t} x`;
    const ra = ta.includes(t) ? (await a.query(sql)).rows[0] : null, rb = tb.includes(t) ? (await b.query(sql)).rows[0] : null;
    const same = ra && rb && ra.n === rb.n && ra.h === rb.h;
    (per[s] ??= { tables: 0, identical: 0, rows: 0 }); per[s].tables++; per[s].rows += rb ? +rb.n : 0;
    if (same) per[s].identical++; else bad.push({ table: t, old_rows: ra ? +ra.n : "missing", new_rows: rb ? +rb.n : "missing", rows_equal: ra && rb ? ra.n === rb.n : false });
  }
  console.table(Object.entries(per).map(([s, v]) => ({ schema: s, tables: v.tables, identical: v.identical, rows_in_new: v.rows })));
  if (bad.length) { console.log("DIFFERENT:"); console.table(bad); }
  else console.log(`ALL ${all.length} TABLES IDENTICAL between the old and the new project (row counts and content).`);
  await a.end(); await b.end();
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
