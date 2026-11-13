// Builds the semantic layer (schema "sem": sem_order_header, sem_order_items, sem_order_payments, sem_labor)
// ONLY from the derived layer (schema "drv"), driven by schema/semantic.yml. Rebuilt each run.
//   node src/build_semantic.js
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { Pool } = require("pg");

const SEM = yaml.load(fs.readFileSync(path.join(__dirname, "../schema/semantic.yml"), "utf8"));
// lookup tables (Semantic definition of 13 Nov: sem_calendar, sem_location, sem_menu_item, sem_menu_group, sem_sales_category, tags)
const LKM = {};
for (const f of ["semantic_lookups.yml", "semantic_product_mix_lookups.yml"])
  for (const m of yaml.load(fs.readFileSync(path.join(__dirname, "../schema", f), "utf8")).models) LKM[m.name] = m;
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
  // m = the model from semantic.yml. A table that already exists (production keeps full history) gets any column the
  // definition has added since (ALTER ... ADD COLUMN, NULL for old rows until they are rebuilt), and rows are inserted
  // by column NAME, so the column order of an older table never matters.
  async function place(t, selectSql, dateExpr, w, m) {
    if (!(await exists(t))) { await pool.query(`CREATE TABLE sem.${t} AS ${selectSql}`); return; }
    const have = new Set((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='sem' AND table_name=$1", [t])).rows.map((r) => r.column_name));
    for (const c of m.columns) if (!have.has(c.name)) { await pool.query(`ALTER TABLE sem.${t} ADD COLUMN ${q(c.name)} ${pgType(c.data_type)}`); console.log(`sem.${t}: added column ${c.name}`); }
    if (w.lo === null) return;
    const names = m.columns.map((c) => q(c.name)).join(", ");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`DELETE FROM sem.${t} WHERE ${dateExpr} BETWEEN $1 AND $2`, [w.lo, w.hi]);
      await c.query(`INSERT INTO sem.${t} (${names}) SELECT ${names} FROM (${selectSql}) x`);
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
      LEFT JOIN drv.drv_service_charge s ON s.store_location_id=o.store_location_id AND s.order_id=o.order_id`, "order_business_date", ow, m);
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
    await place("sem_order_items", parts.join(" UNION ALL "), "order_business_date", ow, m);
  }

  // ---------- sem_order_payments ----------
  {
    const m = model("sem_order_payments");
    const A = { drv_payment: "p", drv_order: "o" };
    const sel = m.columns.map((c) => {
      // definition says "hour in store_timezone": the hour of day (0-23) of the source timestamp, store local time
      if (/hour in store_timezone/i.test(c.meta.how || ""))
        return `extract(hour FROM (${A[c.meta.source_table]}.${q(c.meta.source_column)} AT TIME ZONE ${A[c.meta.source_table]}."store_timezone"))::${pgType(c.data_type)} AS ${q(c.name)}`;
      return `${col(A[c.meta.source_table], c.meta.source_table, c.meta.source_column, pgType(c.data_type), m.name)} AS ${q(c.name)}`;
    });
    await place("sem_order_payments", `SELECT ${sel.join(", ")} FROM drv.drv_payment p
      LEFT JOIN drv.drv_order o ON o.store_location_id=p.store_location_id AND o.order_id=p.order_id`, "order_business_date", ow, m);
  }

  // ---------- sem_labor (shift rows, one per store + time entry; shift_id is empty for unscheduled clock-ins) ----------
  {
    const m = model("sem_labor");
    const sel = m.columns.map((c) => `${col("l", "drv_labor", c.meta.source_column, pgType(c.data_type), m.name)} AS ${q(c.name)}`);
    await place("sem_labor", `SELECT DISTINCT ON (l.store_location_id, l.time_entry_id) ${sel.join(", ")}
      FROM drv.drv_labor l WHERE l.drv_record_type='shift' ORDER BY l.store_location_id, l.time_entry_id`, "nullif(labor_business_date::text,'')::int", lw, m);
  }

  // ---------- lookups built from the setup copy in drv (store / menu / category / tags) ----------
  // The setup (config + menus) is stored as one copy per pull; copy_business_date / last_seen_business_date = the business date of
  // the pull that copy came from. Tables keyed by copy keep every copy (a re-run replaces only its own copy); "latest" tables
  // (location, menu item) are upserted, so a store or item that disappears keeps its last known values.
  {
    const COPY = (a) => `coalesce((SELECT to_date(r.business_date::text,'YYYYMMDD') FROM raw.pull_runs r WHERE r.run_id::text = ${a}."_run_id"::text), (${a}."_extracted_at"::timestamptz AT TIME ZONE ${a}."store_timezone")::date)`;
    const byName = (name, src, a, extra = {}) => LKM[name].columns.map((c) => {
      const t = pgType(c.data_type);
      if (extra[c.name]) return `(${extra[c.name]})::${t} AS ${q(c.name)}`;
      if (have[src] && have[src].has(c.name)) return `${a}.${q(c.name)}::${t} AS ${q(c.name)}`;
      warn.push(`${name}: ${src}.${c.name} missing -> NULL`); return `NULL::${t} AS ${q(c.name)}`;
    }).join(", ");
    const lookup = async (name, selectSql, keys) => {
      await pool.query("DROP TABLE IF EXISTS pg_temp._lk");
      await pool.query(`CREATE TEMP TABLE _lk AS ${selectSql}`);
      if (!(await exists(name))) await pool.query(`CREATE TABLE sem.${name} AS SELECT * FROM _lk`);
      else {
        const k = keys.map(q).join(", ");
        await pool.query(`DELETE FROM sem.${name} WHERE (${k}) IN (SELECT ${k} FROM _lk)`);
        await pool.query(`INSERT INTO sem.${name} (${LKM[name].columns.map((c) => q(c.name)).join(", ")}) SELECT ${LKM[name].columns.map((c) => q(c.name)).join(", ")} FROM _lk`);
      }
      await pool.query("DROP TABLE IF EXISTS pg_temp._lk");
    };
    const has = (t) => { if (have[t]) return true; warn.push(`${t}: not in drv -> lookup skipped`); return false; };
    const latest = (name, src, keys) => `SELECT DISTINCT ON (${keys.map((k) => "x." + q(k)).join(", ")}) ${byName(name, src, "x", { last_seen_business_date: COPY("x") })}
        FROM drv.${src} x ORDER BY ${keys.map((k) => "x." + q(k)).join(", ")}, x."_extracted_at" DESC NULLS LAST`;
    if (has("drv_location")) await lookup("sem_location", latest("sem_location", "drv_location", ["store_location_id"]), ["store_location_id"]);
    if (has("drv_config_menu_item")) await lookup("sem_menu_item", latest("sem_menu_item", "drv_config_menu_item", ["store_location_id", "menu_item_id"]), ["store_location_id", "menu_item_id"]);
    if (has("drv_config_sales_category"))
      await lookup("sem_sales_category", `SELECT DISTINCT ON (x."store_location_id", x."sales_category_id", cp) ${byName("sem_sales_category", "drv_config_sales_category", "x", { copy_business_date: "cp" })}
        FROM (SELECT y.*, ${COPY("y")} AS cp FROM drv.drv_config_sales_category y) x ORDER BY x."store_location_id", x."sales_category_id", cp, x."_extracted_at" DESC NULLS LAST`, ["store_location_id", "sales_category_id", "copy_business_date"]);
    if (has("drv_menus_menu_groups"))
      await lookup("sem_menu_group", `SELECT DISTINCT ON (g.tenant_id, g.store_location_id, g.menu_group_id, g.cp) g.tenant_id::text AS tenant_id, g.store_location_id::text AS store_location_id, g.menu_group_id::text AS menu_group_id,
          g.cp::date AS copy_business_date, g.menu_name::text AS menu_name, g.menu_group_name::text AS menu_group_name, g.menu_group_parent_id::text AS parent_menu_group_id, p.menu_group_name::text AS parent_menu_group_name
        FROM (SELECT y.*, ${COPY("y")} AS cp FROM drv.drv_menus_menu_groups y) g
        LEFT JOIN (SELECT DISTINCT ON (store_location_id, menu_group_id, cp) store_location_id, menu_group_id, menu_group_name, cp FROM (SELECT y.*, ${COPY("y")} AS cp FROM drv.drv_menus_menu_groups y) z
                   ORDER BY store_location_id, menu_group_id, cp, menu_name) p
          ON p.store_location_id = g.store_location_id AND p.menu_group_id = g.menu_group_parent_id AND p.cp = g.cp
        ORDER BY g.tenant_id, g.store_location_id, g.menu_group_id, g.cp, g.menu_name`, ["store_location_id", "menu_group_id", "copy_business_date"]);
    if (has("drv_menus_menu_item_tag"))
      await lookup("sem_menu_item_tag", `SELECT t.tenant_id::text AS tenant_id, t.store_location_id::text AS store_location_id, t.menu_item_id::text AS menu_item_id, t.cp::date AS copy_business_date,
          string_agg(DISTINCT t.item_tag_name, ', ' ORDER BY t.item_tag_name) AS item_tags
        FROM (SELECT y.*, ${COPY("y")} AS cp FROM drv.drv_menus_menu_item_tag y WHERE y.item_tag_name IS NOT NULL) t GROUP BY 1, 2, 3, 4`, ["store_location_id", "menu_item_id", "copy_business_date"]);
    if (has("drv_menus_modifier_option_tag") && has("drv_config_modifier_option"))
      await lookup("sem_modifier_option_tag", `SELECT t.tenant_id::text AS tenant_id, t.store_location_id::text AS store_location_id, o.modifier_option_name::text AS modifier_option_name, t.cp::date AS copy_business_date,
          string_agg(DISTINCT t.item_tag_name, ', ' ORDER BY t.item_tag_name) AS item_tags
        FROM (SELECT y.*, ${COPY("y")} AS cp FROM drv.drv_menus_modifier_option_tag y WHERE y.item_tag_name IS NOT NULL) t
        JOIN (SELECT DISTINCT store_location_id, modifier_option_reference_key, modifier_option_name FROM drv.drv_config_modifier_option) o
          ON o.store_location_id = t.store_location_id AND o.modifier_option_reference_key = t.modifier_option_reference_key
        WHERE o.modifier_option_name IS NOT NULL GROUP BY 1, 2, 3, 4`, ["store_location_id", "modifier_option_name", "copy_business_date"]);
  }

  // ---------- sem_calendar (lookup, generated - no POS data; the same for every tenant; Output's dim_date reads it) ----------
  {
    await pool.query("DROP TABLE IF EXISTS sem.sem_calendar");
    await pool.query(`CREATE TABLE sem.sem_calendar AS
      SELECT d::date AS business_date, to_char(d,'YYYYMMDD')::bigint AS date_int, to_char(d,'Dy') AS day_of_week_code, trim(to_char(d,'Day')) AS day_of_week_name,
        extract(isodow FROM d)::bigint AS day_of_week_number, extract(isodow FROM d) >= 6 AS is_weekend,
        date_trunc('week', d)::date AS week_start_date, extract(week FROM d)::bigint AS iso_week,
        date_trunc('month', d)::date AS month_start_date, trim(to_char(d,'Month')) AS month_name,
        extract(quarter FROM d)::bigint AS quarter, extract(year FROM d)::bigint AS year,
        (d::date - 364) AS same_weekday_last_year, (d - interval '1 year')::date AS same_date_last_year
      FROM generate_series('2022-01-01'::date, '2030-12-31'::date, interval '1 day') d`);
    await pool.query("CREATE UNIQUE INDEX sem_calendar_date ON sem.sem_calendar (business_date)");
  }

  // indexes for the dashboard and the windowed deletes
  for (const [t, cols] of [["sem_order_header", "order_business_date"], ["sem_order_items", "order_business_date, row_type"], ["sem_order_items", "store_location_id, item_id"],
    ["sem_order_payments", "order_business_date"], ["sem_order_payments", "paid_business_date"]])
    await pool.query(`CREATE INDEX IF NOT EXISTS ${t}_${cols.replace(/[^a-z]+/g, "_")} ON sem.${t} (${cols})`);
  const out = [];
  for (const t of ["sem_order_header", "sem_order_items", "sem_order_payments", "sem_labor"])
    out.push({ table: t, rows: +(await pool.query(`select count(*) n from sem.${t}`)).rows[0].n, columns: model(t).columns.length });
  for (const t of Object.keys(LKM).filter((x) => x !== "sem_calendar")) if (await exists(t)) out.push({ table: t, rows: +(await pool.query(`select count(*) n from sem.${t}`)).rows[0].n, columns: LKM[t].columns.length });
  out.push({ table: "sem_calendar", rows: +(await pool.query("select count(*) n from sem.sem_calendar")).rows[0].n, columns: 14 });
  console.table(out);
  console.log("warnings:", warn.length); warn.slice(0, 40).forEach((w) => console.log("  -", w));
  await pool.end();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
