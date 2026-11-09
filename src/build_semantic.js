// Builds the semantic layer (schema "sem": sem_order_header, sem_order_items, sem_order_payments, sem_labor)
// ONLY from the derived layer (schema "drv"), driven by schema/semantic.yml. Rebuilt each run.
//   node src/build_semantic.js
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { Pool } = require("pg");

const SEM = yaml.load(fs.readFileSync(path.join(__dirname, "../schema/semantic.yml"), "utf8"));
const PG = { STRING: "text", NUMERIC: "numeric", INT64: "bigint", BOOL: "boolean", TIMESTAMP: "timestamptz", DATE: "date" };
const pgType = (t) => PG[(t || "STRING").toUpperCase()] || "text";
const q = (s) => '"' + s.replace(/"/g, '""') + '"';
const model = (n) => SEM.models.find((m) => m.name === n);

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const have = {};
  for (const r of (await pool.query("select table_name, column_name from information_schema.columns where table_schema='drv'")).rows) (have[r.table_name] ??= new Set()).add(r.column_name);
  const warn = [];
  const col = (alias, table, c, type, ctx) => {
    if (have[table] && have[table].has(c)) return `${alias}.${q(c)}::${type}`;
    warn.push(`${ctx}: ${table}.${c} missing -> NULL`);
    return `NULL::${type}`;
  };
  // Incremental: sem keeps full history. drv only holds the work window (or a backfill chunk), so the sem rows for
  // the dates present in drv are replaced; everything outside that date range is left untouched.
  await pool.query("CREATE SCHEMA IF NOT EXISTS sem");
  const ow = (await pool.query("SELECT min(order_business_date) lo, max(order_business_date) hi FROM drv.drv_order")).rows[0];
  const lw = (await pool.query("SELECT min(nullif(labor_business_date::text,'')::int) lo, max(nullif(labor_business_date::text,'')::int) hi FROM drv.drv_labor WHERE drv_record_type='shift'")).rows[0];
  console.log(`sem window: orders ${ow.lo}..${ow.hi}, labor ${lw.lo}..${lw.hi}`);
  const exists = async (t) => (await pool.query("SELECT to_regclass($1) r", ["sem." + t])).rows[0].r !== null;
  async function place(t, selectSql, dateExpr, w) {
    if (!(await exists(t))) { await pool.query(`CREATE TABLE sem.${t} AS ${selectSql}`); return; }
    if (w.lo === null) return;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`DELETE FROM sem.${t} WHERE ${dateExpr} BETWEEN $1 AND $2`, [w.lo, w.hi]);
      await c.query(`INSERT INTO sem.${t} SELECT * FROM (${selectSql}) x`);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw new Error(`${t}: ${e.message}`); } finally { c.release(); }
  }

  // ---------- sem_order_header ----------
  {
    const m = model("sem_order_header");
    const A = { drv_order: "o", drv_check: "c", drv_service_charge: "s" };
    const sel = m.columns.map((c) => `${col(A[c.meta.source_table], c.meta.source_table, c.meta.source_column, pgType(c.data_type), m.name)} AS ${q(c.name)}`);
    await place("sem_order_header", `SELECT ${sel.join(", ")}
      FROM drv.drv_order o
      LEFT JOIN drv.drv_check c ON c.store_location_id=o.store_location_id AND c.order_id=o.order_id AND c.check_sequence='0'
      LEFT JOIN drv.drv_service_charge s ON s.store_location_id=o.store_location_id AND s.order_id=o.order_id`, "order_business_date", ow);
  }

  // ---------- sem_order_items (union of 5 row types) ----------
  {
    const m = model("sem_order_items");
    const types = m.meta.union_of; // item/modifier/tax/discount/trigger -> drv table
    const parts = [];
    for (const [rt, base] of Object.entries(types)) {
      const sel = m.columns.map((c) => {
        const t = pgType(c.data_type);
        if (c.name === "row_type") return `'${rt}'::text AS ${q(c.name)}`;
        const e = c.meta.source_by_row_type && c.meta.source_by_row_type[rt];
        if (!e) return `NULL::${t} AS ${q(c.name)}`;
        const alias = e.source_table === base ? "b" : e.source_table === "drv_order" ? "jo" : e.source_table === "drv_items" ? "ji" : null;
        if (!alias) { warn.push(`sem_order_items.${c.name}[${rt}]: unknown source ${e.source_table}`); return `NULL::${t} AS ${q(c.name)}`; }
        return `${col(alias, e.source_table, e.source_column, t, `sem_order_items[${rt}]`)} AS ${q(c.name)}`;
      });
      parts.push(`SELECT ${sel.join(", ")} FROM drv.${base} b
        LEFT JOIN drv.drv_order jo ON jo.store_location_id=b.store_location_id AND jo.order_id=b.order_id
        LEFT JOIN drv.drv_items ji ON ji.store_location_id=b.store_location_id AND ji.item_id=b.item_id`);
    }
    await place("sem_order_items", parts.join(" UNION ALL "), "order_business_date", ow);
  }

  // ---------- sem_order_payments ----------
  {
    const m = model("sem_order_payments");
    const A = { drv_payment: "p", drv_order: "o" };
    const sel = m.columns.map((c) => `${col(A[c.meta.source_table], c.meta.source_table, c.meta.source_column, pgType(c.data_type), m.name)} AS ${q(c.name)}`);
    await place("sem_order_payments", `SELECT ${sel.join(", ")} FROM drv.drv_payment p
      LEFT JOIN drv.drv_order o ON o.store_location_id=p.store_location_id AND o.order_id=p.order_id`, "order_business_date", ow);
  }

  // ---------- sem_labor (shift rows, one per store + time entry; shift_id is empty for unscheduled clock-ins) ----------
  {
    const m = model("sem_labor");
    const sel = m.columns.map((c) => `${col("l", "drv_labor", c.meta.source_column, pgType(c.data_type), m.name)} AS ${q(c.name)}`);
    await place("sem_labor", `SELECT DISTINCT ON (l.store_location_id, l.time_entry_id) ${sel.join(", ")}
      FROM drv.drv_labor l WHERE l.drv_record_type='shift' ORDER BY l.store_location_id, l.time_entry_id`, "nullif(labor_business_date::text,'')::int", lw);
  }

  // indexes for the dashboard and the windowed deletes
  for (const [t, cols] of [["sem_order_header", "order_business_date"], ["sem_order_items", "order_business_date, row_type"], ["sem_order_items", "store_location_id, item_id"],
    ["sem_order_payments", "order_business_date"], ["sem_order_payments", "paid_business_date"]])
    await pool.query(`CREATE INDEX IF NOT EXISTS ${t}_${cols.replace(/[^a-z]+/g, "_")} ON sem.${t} (${cols})`);
  const out = [];
  for (const t of ["sem_order_header", "sem_order_items", "sem_order_payments", "sem_labor"])
    out.push({ table: t, rows: +(await pool.query(`select count(*) n from sem.${t}`)).rows[0].n, columns: model(t).columns.length });
  console.table(out);
  console.log("warnings:", warn.length); warn.slice(0, 40).forEach((w) => console.log("  -", w));
  await pool.end();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
