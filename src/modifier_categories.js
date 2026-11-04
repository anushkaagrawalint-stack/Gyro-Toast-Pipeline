// Adds three sheets to UniqueValues_AllLocations.xlsx:
//   "Modifier analysis"  - every modifier group with locations, selection rules, times sold, revenue and top options sold (from the Neon DB)
//   "Modifier mapping"   - modifier group -> type / sub-type / context, so near-duplicates collapse (Choose 1 Protein, Choose 2 Proteins -> Protein)
//   "Modifier types"     - summary: groups and sales per type
//   node src/modifier_categories.js [--file path.xlsx]
require("dotenv").config({ quiet: true });
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { Pool } = require("pg");
const FILE = path.resolve((i => (i > -1 ? process.argv[i + 1] : path.join(__dirname, "../../SampleReports/UniqueValues_AllLocations.xlsx")))(process.argv.indexOf("--file")));

const { classify } = require("./modifier_rules");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const groups = (await pool.query(`
    WITH g AS (SELECT modifier_group_name n, count(DISTINCT store_location_id) locs, string_agg(DISTINCT store_location_id, ', ' ORDER BY store_location_id) loc_list,
                      max(modifier_group_min_selections) mn, max(modifier_group_max_selections) mx
               FROM input.in_menus_modifier_group_refs WHERE modifier_group_name IS NOT NULL GROUP BY 1),
    o AS (SELECT r.modifier_group_name n, count(DISTINCT x.modifier_option_name) n_opts
          FROM input.in_menus_modifier_group_refs r
          JOIN input.in_menus_modifier_group_option_ref l ON l.store_location_id=r.store_location_id AND l.modifier_group_reference_key=r.modifier_group_reference_key
          JOIN input.in_config_modifier_option x ON x.store_location_id=l.store_location_id AND x.modifier_option_reference_key::text=l.modifier_option_reference_id::text GROUP BY 1),
    u AS (SELECT modifier_group_name n, count(*) FILTER (WHERE is_voided IS NOT TRUE) used, coalesce(round(sum(modifier_price_before_discount) FILTER (WHERE is_voided IS NOT TRUE),2),0) rev
          FROM drv.drv_modifier WHERE modifier_group_name IS NOT NULL GROUP BY 1)
    SELECT g.*, coalesce(o.n_opts,0) n_opts, coalesce(u.used,0) used, coalesce(u.rev,0) rev FROM g LEFT JOIN o USING (n) LEFT JOIN u USING (n) ORDER BY g.n`)).rows;
  const sold = (await pool.query(`SELECT modifier_group_name g, modifier_name m, count(*) n FROM drv.drv_modifier WHERE modifier_group_name IS NOT NULL AND is_voided IS NOT TRUE GROUP BY 1,2`)).rows;
  const top = {};
  for (const x of sold) (top[x.g] ??= []).push([x.m, +x.n]);
  const topStr = (g) => (top[g] || []).sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => `${x[0]} (${x[1]})`).join(", ");
  const missing = [...new Set(sold.map((x) => x.g))].filter((g) => !groups.find((x) => x.n === g));
  for (const g of missing) groups.push({ n: g, locs: 0, loc_list: "(sold but not in menus API)", mn: null, mx: null, n_opts: 0, used: (top[g] || []).reduce((s, x) => s + x[1], 0), rev: 0 });

  const rows = groups.map((g) => ({ ...g, ...classify(g.n) }));
  const review = rows.filter((r) => r.type === "REVIEW");

  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(FILE)) await wb.xlsx.readFile(FILE);
  for (const n of ["Modifier analysis", "Modifier mapping", "Modifier types"]) { const w = wb.getWorksheet(n); if (w) wb.removeWorksheet(w.id); }
  const head = (ws, h, widths) => { ws.addRow(h).font = { bold: true }; ws.columns.forEach((c, i) => (c.width = widths[i])); ws.views = [{ state: "frozen", ySplit: 1 }]; ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: h.length } }; };

  // 1. analysis
  const a = wb.addWorksheet("Modifier analysis");
  head(a, ["Modifier group", "# locations", "Min selections", "Max selections", "# options configured", "Times sold", "Revenue ($)", "Top options actually sold (count)", "Sold in data?"], [46, 12, 14, 14, 18, 12, 14, 90, 14]);
  for (const r of rows) a.addRow([r.n, +r.locs, r.mn === null ? "" : +r.mn, r.mx === null ? "" : +r.mx, +r.n_opts, +r.used, +r.rev, topStr(r.n), +r.used > 0 ? "Yes" : "No (never sold)"]);

  // 2. mapping
  const m = wb.addWorksheet("Modifier mapping");
  head(m, ["Modifier group", "Modifier type", "Sub-type", "Context", "Times sold", "Revenue ($)", "Rule used", "Data-quality note"], [46, 22, 28, 12, 12, 14, 26, 56]);
  for (const r of rows.sort((x, y) => x.type.localeCompare(y.type) || x.sub.localeCompare(y.sub) || x.n.localeCompare(y.n)))
    m.addRow([r.n, r.type, r.sub, r.context, +r.used, +r.rev, r.rule, r.notes]);

  m.addRow([]);
  m.addRow([`All ${rows.length} configured modifier groups are mapped by name, whether or not they were ever sold (${rows.filter((r) => +r.used === 0).length} groups have no sales). Sales columns are for information only.`]).font = { italic: true };

  // 3. types summary
  const s = wb.addWorksheet("Modifier types");
  head(s, ["Modifier type", "Sub-type", "# groups", "Times sold", "Revenue ($)", "Groups in this type"], [24, 30, 10, 12, 14, 120]);
  const agg = {};
  for (const r of rows) { const k = r.type + "|" + r.sub; (agg[k] ??= { type: r.type, sub: r.sub, n: 0, used: 0, rev: 0, names: [] }); const o = agg[k]; o.n++; o.used += +r.used; o.rev += +r.rev; o.names.push(r.n); }
  const list = Object.values(agg).sort((x, y) => x.type.localeCompare(y.type) || y.used - x.used);
  for (const o of list) s.addRow([o.type, o.sub, o.n, o.used, Math.round(o.rev * 100) / 100, o.names.sort().join(" | ")]);
  const types = [...new Set(list.map((o) => o.type))];
  s.addRow([]); s.addRow([`${rows.length} modifier groups -> ${types.length} modifier types -> ${list.length} sub-types`]).font = { bold: true };

  await wb.xlsx.writeFile(FILE);
  console.log("updated:", FILE);
  console.log(`${rows.length} groups -> ${types.length} types -> ${list.length} sub-types; unmapped: ${review.length}`);
  const byType = {};
  for (const o of list) (byType[o.type] ??= { groups: 0, used: 0 }), (byType[o.type].groups += o.n), (byType[o.type].used += o.used);
  console.table(Object.entries(byType).map(([t, v]) => ({ type: t, groups: v.groups, times_sold: v.used })));
  console.table(list.map((o) => ({ type: o.type, sub_type: o.sub, groups: o.n, sold: o.used })));
  if (review.length) console.log("REVIEW:", review.map((r) => r.n).join(" | "));
  await pool.end();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
