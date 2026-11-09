// Builds the input layer (schema "input", in_* tables) from the SOR layer (raw.*),
// driven entirely by schema/raw-input.yaml.
//   node src/build_input.js [--run <run_id>]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { Pool } = require("pg");

const SPEC = yaml.load(fs.readFileSync(path.join(__dirname, "../schema/raw-input.yaml"), "utf8"));

// ---- scope: orders, menus, config, labor ----------------------------------------------
const ORDER_TABLES = ["in_order", "in_order_pricing_feature", "in_check", "in_service_charge", "in_items",
  "in_modifier", "in_payment", "in_tax", "in_discount", "in_discount_combo_item", "in_discount_trigger_item"];
const inScope = (t) => ORDER_TABLES.includes(t) || /^in_(config|menus|labor)_/.test(t);
const TABLES = Object.keys(SPEC).filter((k) => k.startsWith("in_") && inScope(k));

// ---- entity -> SOR endpoint ------------------------------------------------------------
const ENTITY_EP = {
  menu_groups: "/config/v2/menuGroups", menu_items: "/config/v2/menuItems",
  menu_option_groups: "/config/v2/menuOptionGroups", menus: "/menus/v2/menus",
  payout_reasons: "/config/v2/payoutReasons", price_groups: "/config/v2/priceGroups",
  printers: "/config/v2/printers", restaurant_services: "/config/v2/restaurantServices",
  revenue_centers: "/config/v2/revenueCenters", sales_categories: "/config/v2/salesCategories",
  service_areas: "/config/v2/serviceAreas", service_charges: "/config/v2/serviceCharges",
  tables: "/config/v2/tables", tax_rates: "/config/v2/taxRates", tip_withholding: "/config/v2/tipWithholding",
  void_reasons: "/config/v2/voidReasons", break_types: "/config/v2/breakTypes",
  cash_drawers: "/config/v2/cashDrawers", dining_options: "/config/v2/diningOptions",
  discounts: "/config/v2/discounts", alternate_payment_types: "/config/v2/alternatePaymentTypes",
  time_entries: "/labor/v1/timeEntries", employees: "/labor/v1/employees", jobs: "/labor/v1/jobs",
  no_sale_reasons: null, // not available to these credentials -> table stays empty
};
const entityOf = (spec) => (spec.source_entity === null ? "menus_cfg" : spec.source_entity);
ENTITY_EP.menus_cfg = "/config/v2/menus"; // in_config_menu* have source_entity null: config.menus

// ---- write scope (yaml says null except in_order; these are my choices) ----------------
const scopeOf = (t, spec) =>
  ORDER_TABLES.includes(t) ? "order" : spec.source_entity === "time_entries" ? "time_entry" : "store";

// ---- helpers ---------------------------------------------------------------------------
const colName = (to) => to.split("/")[0].trim();
const DDL = { ID: "text", TEXT: "text", NUMERIC: "numeric", INT: "numeric", DATE_INT: "integer",
  BOOLEAN: "boolean", TIMESTAMP_UTC: "timestamptz", JSON_TEXT: "text" };
const getPath = (o, p) => {
  let c = o;
  for (const k of p.split(".")) { if (c == null || typeof c !== "object") return null; c = c[k]; }
  return c === undefined ? null : c;
};
function coerce(v, type) {
  if (v === undefined || v === null) return null;
  switch (type) {
    case "JSON_TEXT": return JSON.stringify(v);
    case "NUMERIC": case "INT": case "DATE_INT": return typeof v === "number" ? v : Number(v);
    case "BOOLEAN": return typeof v === "boolean" ? v : String(v).toLowerCase() === "true";
    default: return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

// ---- walker ----------------------------------------------------------------------------
function* walk(cur, steps, i, frames) {
  if (i === steps.length) return;
  const s = steps[i];
  const rec = s.endsWith("*"), map = s.endsWith("{}");
  const base = s.replace(/\*$|\{\}$/g, "");
  const coll = getPath(cur, base);
  const last = i === steps.length - 1;
  const items = [];
  if (map) { if (coll && typeof coll === "object") Object.entries(coll).forEach(([k, v], idx) => items.push({ el: v, index: idx, key: k, chain: [v] })); }
  else if (Array.isArray(coll)) {
    const expand = (arr, chain) => arr.forEach((e, idx) => {
      items.push({ el: e, index: idx, key: null, chain: [...chain, e] });
      if (rec && e && Array.isArray(e[base])) expand(e[base], [...chain, e]);
    });
    expand(coll, []);
  }
  for (const it of items) {
    const f = { name: base, ...it };
    if (last) yield [...frames, f];
    else yield* walk(it.el, steps, i + 1, [...frames, f]);
  }
}
function resolveParent(path, root, frames) {
  let up = false;
  if (path.startsWith("^")) { up = true; path = path.slice(1); }
  const names = frames.map((f) => f.name);
  let k = 0;
  for (let n = names.length; n >= 1; n--) if (path.startsWith(names.slice(0, n).join(".") + ".")) { k = n; break; }
  if (k === 0) return getPath(root, path);
  const field = path.slice(names.slice(0, k).join(".").length + 1);
  const f = frames[k - 1];
  if (field === "$index") return up ? null : f.index;
  if (field === "$key") return up ? null : f.key;
  const el = up ? f.chain[f.chain.length - 2] : f.el;
  return el == null ? null : getPath(el, field);
}

// ---- build rows of one table from one root record --------------------------------------
function rowsFromRoot(spec, root, loc) {
  const entries = spec.rows ? spec.rows : [{ path: spec.row_path, parents: spec.parents || {} }];
  const out = [];
  for (const ent of entries) {
    const steps = ent.path;
    const emit = (frames) => {
      const parents = {};
      for (const [pk, pp] of Object.entries(ent.parents || {})) parents[pk] = resolveParent(pp, root, frames);
      const last = frames.length ? frames[frames.length - 1] : { el: root, index: 0, key: null };
      if (last.el === null || last.el === undefined) return;
      const row = {};
      for (const c of spec.columns) {
        let v;
        if (c.from === "$location") v = loc;
        else if (c.from === "$parent") v = parents[colName(c.to)] ?? null;
        else if (c.from === "$index") v = last.index;
        else if (c.from === "$key") v = last.key;
        else if (c.from === "$value") v = last.el;
        else v = getPath(last.el, c.from);
        row[colName(c.to)] = coerce(v, c.type);
      }
      out.push(row);
    };
    if (steps.length === 0) emit([]);
    else for (const frames of walk(root, steps, 0, [])) emit(frames);
  }
  return out;
}

// ---- main ------------------------------------------------------------------------------
// Incremental, windowed build (leaner storage):
//   default:            work window = the last WINDOW_DAYS business days (+ any later, pre-ordered dates). Only orders that
//                       changed since the last build (fetched_at > watermark) or are missing from input are (re)built.
//                       Orders older than the window are removed from input (history lives in raw/sem/output).
//   --from YYYYMMDD --to YYYYMMDD   explicit range (backfill chunk): every order in the range is built and input holds
//                       exactly that range afterwards. The watermark is not touched.
//   --full              ignore the watermark (rebuild every order in the window)
const WINDOW_DAYS = 45;
const BATCH = 2500; // orders per batch (bounds memory)
const argv = (n) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : null; };
const ymd = (d) => Number(d.toISOString().slice(0, 10).replace(/-/g, ""));
const chicagoToday = () => Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date()).replace(/-/g, ""));
const addDaysInt = (n, k) => { const s = String(n), d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) + k * 864e5); return ymd(d); };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const FROM = argv("from") ? Number(argv("from")) : null, TO = argv("to") ? Number(argv("to")) : null;
  const explicit = FROM !== null && TO !== null;
  const lo = explicit ? FROM : addDaysInt(chicagoToday(), -WINDOW_DAYS);
  const hi = explicit ? TO : 99991231;
  // config / menus come from the latest successful FULL pull (lean backfill pulls carry no config)
  const cfgRun = (await pool.query(`SELECT a.run_id FROM raw.api_responses a JOIN raw.pull_runs r ON r.run_id=a.run_id
      WHERE r.status IN ('success','partial') AND a.endpoint='/menus/v2/menus' AND a.http_status=200 ORDER BY r.started_at DESC LIMIT 1`)).rows[0];
  if (!cfgRun) throw new Error("no full pull with menus/config found");
  console.log(`input build: window ${lo}..${explicit ? hi : "(open)"}${explicit ? " [explicit range]" : ""}; config from run ${cfgRun.run_id}`);

  // DDL
  await pool.query('CREATE SCHEMA IF NOT EXISTS "input"');
  await pool.query(`CREATE TABLE IF NOT EXISTS "input"._build_state (key text PRIMARY KEY, value text, updated_at timestamptz DEFAULT now())`);
  const colsOf = {};
  for (const t of TABLES) {
    const names = SPEC[t].columns.map((c) => colName(c.to));
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) throw new Error(`${t}: duplicate column names ${[...new Set(dup)]}`);
    colsOf[t] = SPEC[t].columns.map((c) => ({ name: colName(c.to), type: c.type }));
    await pool.query(`CREATE TABLE IF NOT EXISTS "input"."${t}" (${colsOf[t].map((c) => `"${c.name}" ${DDL[c.type]}`).join(", ")})`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS "${t}_key" ON "input"."${t}" (${SPEC[t].key.map((k) => `"${k}"`).join(",")}) NULLS NOT DISTINCT`);
    if (ORDER_TABLES.includes(t)) await pool.query(`CREATE INDEX IF NOT EXISTS "${t}_order" ON "input"."${t}" (order_id)`);
  }
  const counts = {}, dups = {};
  TABLES.forEach((t) => (counts[t] = 0));

  // writes rows for a set of tables: delete the scope, then insert (deduped by key)
  async function write(client, tables, rowsBy, scope) {
    for (const t of tables) {
      const spec = SPEC[t], sc = scopeOf(t, spec);
      if (sc === "order") await client.query(`DELETE FROM "input"."${t}" WHERE order_id = ANY($1)`, [scope.order]);
      else if (sc === "time_entry") await client.query(`DELETE FROM "input"."${t}" WHERE time_entry_id = ANY($1)`, [scope.time_entry]);
      else if (scope.store[t] && scope.store[t].length) await client.query(`DELETE FROM "input"."${t}" WHERE store_location_id = ANY($1)`, [scope.store[t]]);
      const seen = new Map();
      for (const r of rowsBy[t] || []) { const k = JSON.stringify(spec.key.map((c) => r[c])); if (seen.has(k)) dups[t] = (dups[t] || 0) + 1; seen.set(k, r); }
      const rows = [...seen.values()], cols = colsOf[t], per = Math.max(1, Math.floor(30000 / cols.length));
      for (let i = 0; i < rows.length; i += per) {
        const params = [], vals = rows.slice(i, i + per).map((r) => "(" + cols.map((c) => { params.push(r[c.name]); return "$" + params.length; }).join(",") + ")");
        try { await client.query(`INSERT INTO "input"."${t}" (${cols.map((c) => `"${c.name}"`).join(",")}) VALUES ${vals.join(",")}`, params); }
        catch (e) { throw new Error(`${t}: ${e.message}`); }
      }
      counts[t] += rows.length;
    }
  }

  // ---- orders, in batches
  const wm = explicit || process.argv.includes("--full") ? null
    : (await pool.query(`SELECT value FROM "input"._build_state WHERE key='orders_watermark'`)).rows[0]?.value || null;
  const newWm = (await pool.query(`SELECT max(fetched_at)::text m FROM raw.toast_orders`)).rows[0].m;
  const ids = (await pool.query(`
      SELECT t.order_guid FROM raw.toast_orders t
       WHERE t.business_date BETWEEN $1 AND $2
         AND ($3::timestamptz IS NULL OR t.fetched_at > $3::timestamptz
              OR NOT EXISTS (SELECT 1 FROM "input".in_order i WHERE i.order_id = t.order_guid::text))
       ORDER BY t.business_date, t.order_guid`, [lo, hi, wm])).rows.map((r) => r.order_guid);
  console.log(`orders to (re)build: ${ids.length}${wm ? " (changed since " + wm + " or missing)" : ""}`);
  for (let b = 0; b < ids.length; b += BATCH) {
    const batch = ids.slice(b, b + BATCH);
    const orders = (await pool.query(`SELECT order_guid, location_name, payload FROM raw.toast_orders WHERE order_guid = ANY($1::uuid[])`, [batch])).rows;
    const rowsBy = {};
    for (const o of orders) for (const t of ORDER_TABLES) (rowsBy[t] ||= []).push(...rowsFromRoot(SPEC[t], o.payload, o.location_name));
    const client = await pool.connect();
    try { await client.query("BEGIN"); await write(client, ORDER_TABLES, rowsBy, { order: orders.map((o) => o.order_guid), time_entry: [], store: {} }); await client.query("COMMIT"); }
    catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  }

  // ---- config / menus / labor (per location). Snapshots stored once are resolved through same_as_id.
  const locs = (await pool.query("select location_guid, location_name from raw.tenant_locations order by 2")).rows;
  const rowsBy = {}, scope = { order: [], time_entry: [], store: {} };
  for (const l of locs) {
    const resp = (await pool.query(
      `SELECT a.endpoint, a.page_no, a.http_status, coalesce(a.payload, s.payload) payload
         FROM raw.api_responses a LEFT JOIN raw.api_responses s ON s.id = a.same_as_id
        WHERE a.location_guid=$2 AND (
              (a.run_id=$1 AND a.endpoint NOT LIKE '/orders/%' AND a.endpoint <> '/labor/v1/timeEntries')
           OR (a.endpoint='/labor/v1/timeEntries' AND a.http_status=200 AND (a.request_params->>'businessDate')::int BETWEEN $3 AND $4
               AND a.run_id IN (SELECT run_id FROM raw.pull_runs WHERE status IN ('success','partial'))))
        ORDER BY a.endpoint, a.run_id, a.page_no, a.id`,
      [cfgRun.run_id, l.location_guid, lo, Math.min(hi, 99991231)])).rows;
    const byEp = {};
    for (const r of resp) (byEp[r.endpoint] ||= []).push(r);
    for (const t of TABLES) {
      if (ORDER_TABLES.includes(t)) continue;
      const ep = ENTITY_EP[entityOf(SPEC[t])];
      if (!ep) continue;
      const pages = (byEp[ep] || []).filter((p) => p.http_status >= 200 && p.http_status < 300 && p.payload !== null);
      if (!pages.length) continue;
      if (scopeOf(t, SPEC[t]) === "store") (scope.store[t] ||= []).push(l.location_name);
      for (const p of pages) {
        for (const root of Array.isArray(p.payload) ? p.payload : [p.payload]) {
          if (root === null || (typeof root === "object" && !Array.isArray(root) && Object.keys(root).length === 0)) continue;
          (rowsBy[t] ||= []).push(...rowsFromRoot(SPEC[t], root, l.location_name));
          if (scopeOf(t, SPEC[t]) === "time_entry" && root && root.guid) scope.time_entry.push(root.guid);
        }
      }
    }
  }
  const other = TABLES.filter((t) => !ORDER_TABLES.includes(t));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await write(client, other, rowsBy, scope);
    // ---- prune: input keeps only the window (history lives in raw / sem / output)
    const outside = `SELECT order_id FROM "input".in_order WHERE order_business_date < ${lo}${explicit ? ` OR order_business_date > ${hi}` : ""}`;
    let pruned = 0;
    for (const t of ORDER_TABLES.filter((x) => x !== "in_order")) await client.query(`DELETE FROM "input"."${t}" WHERE order_id IN (${outside})`);
    pruned = (await client.query(`DELETE FROM "input".in_order WHERE order_id IN (${outside})`)).rowCount;
    const teOut = `SELECT time_entry_id FROM "input".in_labor_time_entry WHERE nullif(labor_business_date::text,'')::int < ${lo}${explicit ? ` OR nullif(labor_business_date::text,'')::int > ${hi}` : ""}`;
    await client.query(`DELETE FROM "input".in_labor_time_entry_break WHERE time_entry_id IN (${teOut})`);
    await client.query(`DELETE FROM "input".in_labor_time_entry WHERE time_entry_id IN (${teOut})`);
    if (!explicit) await client.query(`INSERT INTO "input"._build_state(key,value,updated_at) VALUES ('orders_watermark',$1,now())
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [newWm]);
    await client.query("COMMIT");
    console.log(`pruned ${pruned} orders outside the window`);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }

  const inOrders = (await pool.query(`SELECT count(*) n, min(order_business_date) mn, max(order_business_date) mx FROM "input".in_order`)).rows[0];
  console.log(`tables=${TABLES.length}; input now holds ${inOrders.n} orders (${inOrders.mn}..${inOrders.mx})`);
  console.table(Object.entries(counts).filter(([, n]) => n > 0).map(([t, n]) => ({ table: t, rows_written: n, dup_keys_collapsed: dups[t] || 0 })));
  await pool.end();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
