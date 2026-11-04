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
async function main() {
  const ai = process.argv.indexOf("--run");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const runId = ai > -1 ? process.argv[ai + 1]
    : (await pool.query("select run_id from raw.pull_runs where status='success' order by started_at desc limit 1")).rows[0].run_id;
  console.log("input build from SOR run", runId);

  // DDL
  await pool.query('CREATE SCHEMA IF NOT EXISTS "input"');
  const colsOf = {};
  for (const t of TABLES) {
    const names = SPEC[t].columns.map((c) => colName(c.to));
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) throw new Error(`${t}: duplicate column names ${[...new Set(dup)]}`);
    colsOf[t] = SPEC[t].columns.map((c) => ({ name: colName(c.to), type: c.type }));
    await pool.query(`CREATE TABLE IF NOT EXISTS "input"."${t}" (${colsOf[t].map((c) => `"${c.name}" ${DDL[c.type]}`).join(", ")})`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS "${t}_key" ON "input"."${t}" (${SPEC[t].key.map((k) => `"${k}"`).join(",")}) NULLS NOT DISTINCT`);
  }

  const locs = (await pool.query("select location_guid, location_name from raw.tenant_locations order by 2")).rows;
  const rowsBy = {}; TABLES.forEach((t) => (rowsBy[t] = []));
  const dups = {};
  const scopeIds = { order: new Set(), time_entry: new Set(), store: new Set() };
  const scopeOK = {}; // table -> Set(location) where source data exists
  const sample = (r) => r;

  // ---- orders
  const orders = (await pool.query("select order_guid, location_name, payload from raw.toast_orders")).rows;
  for (const o of orders) {
    scopeIds.order.add(o.order_guid);
    for (const t of ORDER_TABLES) rowsBy[t].push(...rowsFromRoot(SPEC[t], o.payload, o.location_name));
  }

  // ---- api payload based entities (config / menus / labor)
  for (const l of locs) {
    const resp = (await pool.query(
      "select endpoint, page_no, http_status, payload from raw.api_responses where run_id=$1 and location_guid=$2 order by endpoint, page_no, id",
      [runId, l.location_guid])).rows;
    const byEp = {};
    for (const r of resp) (byEp[r.endpoint] ||= []).push(r);
    for (const t of TABLES) {
      if (ORDER_TABLES.includes(t)) continue;
      const ep = ENTITY_EP[entityOf(SPEC[t])];
      if (!ep) continue;
      const pages = (byEp[ep] || []).filter((p) => p.http_status >= 200 && p.http_status < 300);
      if (!pages.length) continue;
      (scopeOK[t] ||= new Set()).add(l.location_name);
      for (const p of pages) {
        const roots = Array.isArray(p.payload) ? p.payload : [p.payload];
        for (const root of roots) {
          if (root === null || (typeof root === "object" && !Array.isArray(root) && Object.keys(root).length === 0)) continue;
          rowsBy[t].push(...rowsFromRoot(SPEC[t], root, l.location_name));
          if (scopeOf(t, SPEC[t]) === "time_entry" && root && root.guid) scopeIds.time_entry.add(root.guid);
        }
      }
    }
  }

  // ---- write
  const client = await pool.connect();
  const counts = {};
  try {
    await client.query("BEGIN");
    for (const t of TABLES) {
      const spec = SPEC[t], sc = scopeOf(t, spec);
      if (sc === "order") await client.query(`DELETE FROM "input"."${t}" WHERE order_id = ANY($1)`, [[...scopeIds.order]]);
      else if (sc === "time_entry") {
        const idcol = t === "in_labor_time_entry" ? "time_entry_id" : "time_entry_id";
        await client.query(`DELETE FROM "input"."${t}" WHERE "${idcol}" = ANY($1)`, [[...scopeIds.time_entry]]);
      } else if (scopeOK[t] && scopeOK[t].size)
        await client.query(`DELETE FROM "input"."${t}" WHERE store_location_id = ANY($1)`, [[...scopeOK[t]]]);
      // dedupe by key (last wins)
      const seen = new Map();
      for (const r of rowsBy[t]) {
        const k = JSON.stringify(spec.key.map((c) => r[c]));
        if (seen.has(k)) dups[t] = (dups[t] || 0) + 1;
        seen.set(k, r);
      }
      const rows = [...seen.values()];
      const cols = colsOf[t];
      const per = Math.max(1, Math.floor(30000 / cols.length));
      for (let i = 0; i < rows.length; i += per) {
        const chunk = rows.slice(i, i + per);
        const params = [];
        const vals = chunk.map((r) => "(" + cols.map((c) => { params.push(r[c.name]); return "$" + params.length; }).join(",") + ")");
        try {
          await client.query(`INSERT INTO "input"."${t}" (${cols.map((c) => `"${c.name}"`).join(",")}) VALUES ${vals.join(",")}`, params);
        } catch (e) { throw new Error(`${t}: ${e.message}`); }
      }
      counts[t] = rows.length;
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }

  console.log(`tables=${TABLES.length}`);
  console.table(Object.entries(counts).filter(([, n]) => n > 0).map(([t, n]) => ({ table: t, rows: n, dup_keys_collapsed: dups[t] || 0 })));
  console.log("empty tables:", Object.entries(counts).filter(([, n]) => n === 0).map(([t]) => t).join(", "));
  await pool.end();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
