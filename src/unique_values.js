// One workbook of unique reference values across all locations (from the input layer).
//   node src/unique_values.js [--out file.xlsx]
require("dotenv").config({ quiet: true });
const path = require("path");
const ExcelJS = require("exceljs");
const { Pool } = require("pg");
const OUT = path.resolve((i => (i > -1 ? process.argv[i + 1] : path.join(__dirname, "../../SampleReports/UniqueValues_AllLocations.xlsx")))(process.argv.indexOf("--out")));

// each sheet: [sheet name, columns [{h, k}], SQL returning those keys + store_location_id aggregated]
const LOC = `count(DISTINCT store_location_id) AS locations_count, string_agg(DISTINCT store_location_id, ', ' ORDER BY store_location_id) AS locations`;
const SHEETS = [
  ["Payment types", [["Payment type", "payment_type"], ["Sub type (card type / other payment name)", "sub_type"], ["Source", "source"], ["Payments in data", "n"], ["# locations", "locations_count"], ["Locations", "locations"]],
    `SELECT payment_type, coalesce(card_type, other_payment_name, '') AS sub_type, 'payments data' AS source, count(*) AS n, ${LOC}
       FROM (SELECT p.*, a.other_payment_name FROM input.in_payment p LEFT JOIN input.in_config_alt_payment_type a ON a.store_location_id=p.store_location_id AND a.other_payment_id=p.other_payment_id) x GROUP BY 1,2
     UNION ALL
     SELECT 'OTHER', other_payment_name, 'config only (never used in data)', 0, ${LOC} FROM input.in_config_alt_payment_type
       WHERE other_payment_name NOT IN (SELECT other_payment_name FROM input.in_payment p JOIN input.in_config_alt_payment_type a ON a.store_location_id=p.store_location_id AND a.other_payment_id=p.other_payment_id WHERE other_payment_name IS NOT NULL) GROUP BY 2
     ORDER BY 1, 2`],
  ["Break types", [["Break type", "break_type_name"], ["Paid break", "is_paid_break"], ["# locations", "locations_count"], ["Locations", "locations"]],
    `SELECT break_type_name, bool_or(is_paid_break) AS is_paid_break, ${LOC} FROM input.in_config_break_type GROUP BY 1 ORDER BY 1`],
  ["Dining options", [["Dining option", "dining_option_name"], ["Behavior", "dining_option_behavior"], ["# locations", "locations_count"], ["Locations", "locations"]],
    `SELECT dining_option_name, max(dining_option_behavior) AS dining_option_behavior, ${LOC} FROM input.in_config_dining_option GROUP BY 1 ORDER BY 1`],
  ["Menus", [["Menu", "menu_name"], ["# locations", "locations_count"], ["Locations", "locations"]],
    `SELECT menu_name, ${LOC} FROM input.in_menus_menus GROUP BY 1 ORDER BY 1`],
  ["Menu groups", [["Menu group", "menu_group_name"], ["# menus it appears in", "menus_n"], ["Menus", "menus"], ["# locations", "locations_count"], ["Locations", "locations"]],
    `SELECT menu_group_name, count(DISTINCT menu_name) AS menus_n, string_agg(DISTINCT menu_name, ' | ' ORDER BY menu_name) AS menus, ${LOC} FROM input.in_menus_menu_groups WHERE menu_group_name IS NOT NULL GROUP BY 1 ORDER BY 1`],
  ["Modifier groups", [["Modifier group", "modifier_group_name"], ["# locations", "locations_count"], ["Locations", "locations"]],
    `SELECT modifier_group_name, ${LOC} FROM input.in_menus_modifier_group_refs WHERE modifier_group_name IS NOT NULL GROUP BY 1 ORDER BY 1`],
  ["Revenue centers", [["Revenue center", "revenue_center_name"], ["# locations", "locations_count"], ["Locations", "locations"]],
    `SELECT revenue_center_name, ${LOC} FROM input.in_config_revenue_center GROUP BY 1 ORDER BY 1`],
  ["Sales categories", [["Sales category", "sales_category_name"], ["# locations", "locations_count"], ["Locations", "locations"]],
    `SELECT sales_category_name, ${LOC} FROM input.in_config_sales_category GROUP BY 1 ORDER BY 1`],
];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const nLoc = +(await pool.query("select count(distinct store_location_id) n from input.in_order")).rows[0].n;
  const wb = new ExcelJS.Workbook();
  const sum = wb.addWorksheet("Summary");
  sum.addRow(["Sheet", "Unique values", "In all locations", "Source"]).font = { bold: true };
  const src = { "Payment types": "input.in_payment + config other payment types", "Break types": "config break types", "Dining options": "config dining options", "Menus": "menus API", "Menu groups": "menus API",
    "Modifier groups": "menus API (modifier group references)", "Revenue centers": "config revenue centers", "Sales categories": "config sales categories" };
  const counts = [];
  for (const [name, cols, sql] of SHEETS) {
    const rows = (await pool.query(sql)).rows;
    const ws = wb.addWorksheet(name);
    ws.addRow(cols.map((c) => c[0])).font = { bold: true };
    for (const r of rows) ws.addRow(cols.map((c) => (typeof r[c[1]] === "boolean" ? (r[c[1]] ? "Yes" : "No") : r[c[1]] === null ? "" : /^\d+$/.test(String(r[c[1]])) && c[1] !== "sub_type" ? Number(r[c[1]]) : r[c[1]])));
    ws.columns.forEach((c, i) => (c.width = cols[i][1] === "locations" || cols[i][1] === "menus" ? 60 : cols[i][1].includes("name") || cols[i][1] === "sub_type" ? 42 : 16));
    ws.views = [{ state: "frozen", ySplit: 1 }]; ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    const all = rows.filter((r) => +r.locations_count === nLoc).length;
    counts.push([name, rows.length, all, src[name]]);
  }
  counts.forEach((c) => sum.addRow(c)); sum.addRow([]); sum.addRow([`Locations in the data: ${nLoc}. Values are exact (case-sensitive); spelling variants appear as separate rows.`]);
  sum.columns = [{ width: 20 }, { width: 16 }, { width: 18 }, { width: 50 }];
  await wb.xlsx.writeFile(OUT);
  console.log("written:", OUT); console.table(counts.map((c) => ({ sheet: c[0], unique: c[1], in_all_locations: c[2] })));
  await pool.end();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
