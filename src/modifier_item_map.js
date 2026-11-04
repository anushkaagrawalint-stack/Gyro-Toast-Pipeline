// Uses the configured menu structure (menu item -> modifier groups -> options, from the menus API) to
//   1. add the sheet "Modifier item map": which parent item carries which modifier group (and its type), and
//   2. add the sheet "Modifier mapping check": does each group's name-based type agree with what its options actually are?
//   node src/modifier_item_map.js [--file path.xlsx]
require("dotenv").config({ quiet: true });
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { Pool } = require("pg");
const { classify } = require("./modifier_rules");
const FILE = path.resolve((i => (i > -1 ? process.argv[i + 1] : path.join(__dirname, "../../SampleReports/UniqueValues_AllLocations.xlsx")))(process.argv.indexOf("--file")));

// option name -> what the option is (independent of the group's name)
const OPT = [
  [/hummus/i, "Hummus & pita"], [/pita/i, "Hummus & pita"],
  [/rice|half & half/i, "Rice"],
  [/sauce|aioli|tzatziki|tatziki|creamy white|mild orange|red hot|bbq|barbecue|^orange$|^red$|garlic|cheddar|on the side|on my (bowl|entree)/i, "Sauce"],
  [/feta|shredded cheese|cheese|meal deal|fries & fountain/i, "Add-ons"],
  [/coke|coca|sprite|pepsi|dr\.? pepper|jarritos|saratoga|red bull|water|starry|soda|sunkist|drink/i, "Beverage"],
  [/baklava|brownie|cookie|dessert|^regular fries$|fries/i, "Dessert & sides"],
  [/lettuce|tomato|cucumber|cucmber|onion|bell pepper|olive|olice|corn|chickpea|chicpea|jalape|pickle|topping|salad/i, "Toppings"],
  [/chicken|gyro|falafel|ny |tikka|protein|scoop|combo/i, "Protein"],
];
const optType = (n) => { const h = OPT.find((o) => o[0].test(n)); return h ? h[1] : "Other"; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  // join diagnostics
  const diag = (await pool.query(`
    SELECT (SELECT count(*) FROM input.in_menus_menu_item_modifier_group_ref) item_group_links,
      (SELECT count(*) FROM input.in_menus_menu_item_modifier_group_ref m JOIN input.in_menus_modifier_group_refs g ON g.store_location_id=m.store_location_id AND g.modifier_group_reference_key::text=m.modifier_group_reference_id::text) linked_to_group,
      (SELECT count(*) FROM input.in_menus_modifier_group_option_ref) group_option_links,
      (SELECT count(*) FROM input.in_menus_modifier_group_option_ref r JOIN input.in_config_modifier_option o ON o.store_location_id=r.store_location_id AND o.modifier_option_reference_key::text=r.modifier_option_reference_id::text) linked_to_option`)).rows[0];
  console.log("join check:", JSON.stringify(diag));

  // options per modifier group NAME (across all locations)
  const optRows = (await pool.query(`
    SELECT g.modifier_group_name g, o.modifier_option_name o, count(DISTINCT g.store_location_id) locs
    FROM input.in_menus_modifier_group_refs g
    JOIN input.in_menus_modifier_group_option_ref r ON r.store_location_id=g.store_location_id AND r.modifier_group_reference_key=g.modifier_group_reference_key
    JOIN input.in_config_modifier_option o ON o.store_location_id=r.store_location_id AND o.modifier_option_reference_key::text=r.modifier_option_reference_id::text
    WHERE g.modifier_group_name IS NOT NULL GROUP BY 1,2`)).rows;
  const opts = {};
  for (const x of optRows) (opts[x.g] ??= []).push(x.o);

  // parent items per modifier group
  const links = (await pool.query(`
    SELECT i.menu_name, i.menu_group_name, i.menu_item_name, g.modifier_group_name g, count(DISTINCT m.store_location_id) locs
    FROM input.in_menus_menu_item_modifier_group_ref m
    JOIN input.in_menus_menu_items i ON i.store_location_id=m.store_location_id AND i.menu_item_id=m.menu_item_id AND i.menu_group_id=m.menu_group_id
    JOIN input.in_menus_modifier_group_refs g ON g.store_location_id=m.store_location_id AND g.modifier_group_reference_key::text=m.modifier_group_reference_id::text
    WHERE g.modifier_group_name IS NOT NULL GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`)).rows;
  const groupsAll = (await pool.query(`SELECT DISTINCT modifier_group_name n FROM input.in_menus_modifier_group_refs WHERE modifier_group_name IS NOT NULL`)).rows.map((x) => x.n);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  for (const n of ["Modifier item map", "Modifier mapping check"]) { const w = wb.getWorksheet(n); if (w) wb.removeWorksheet(w.id); }
  const head = (ws, h, widths) => { ws.addRow(h).font = { bold: true }; ws.columns.forEach((c, i) => (c.width = widths[i])); ws.views = [{ state: "frozen", ySplit: 1 }]; ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: h.length } }; };

  // sheet 1: item -> group -> options
  const s1 = wb.addWorksheet("Modifier item map");
  head(s1, ["Menu", "Menu group", "Parent item", "Modifier group", "Modifier type", "Sub-type", "# options", "Options in the group", "# locations"], [30, 22, 36, 40, 20, 26, 10, 90, 11]);
  const parents = {};
  for (const l of links) {
    const c = classify(l.g), o = (opts[l.g] || []).sort();
    s1.addRow([l.menu_name, l.menu_group_name, l.menu_item_name, l.g, c.type, c.sub, o.length, o.slice(0, 14).join(", ") + (o.length > 14 ? ` ... (+${o.length - 14})` : ""), +l.locs]);
    const k = (parents[l.g] ??= { items: new Set(), menus: new Set() });
    k.items.add(l.menu_item_name); k.menus.add(l.menu_name);
  }

  // sheet 2: name-based type vs option-based type
  const s2 = wb.addWorksheet("Modifier mapping check");
  head(s2, ["Modifier group", "Type (by name)", "Type suggested by its options", "Agrees?", "Option mix", "# parent items", "Parent items (sample)", "Menus"], [44, 22, 26, 12, 70, 12, 70, 50]);
  const results = [];
  for (const g of groupsAll.sort()) {
    const c = classify(g), o = opts[g] || [];
    const cnt = {};
    for (const n of o) { const t = optType(n); cnt[t] = (cnt[t] || 0) + 1; }
    const ranked = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
    const dom = ranked.length ? ranked[0][0] : "(no options)";
    // add-ons / trays legitimately mix option types; a tray picker holds products
    const base = c.type === "Extra Pita" || c.type === "Extra Hummus" ? "Hummus & pita" : c.type.replace(/^Extra /, ""); // "Extra Protein" is still a protein
    const lenient = base === "Add-ons" || base === "Size & catering trays";
    const agrees = !ranked.length ? "n/a" : lenient || dom === base || (cnt[base] || 0) >= 0.4 * o.length ? "Yes" : "REVIEW";
    const pr = parents[g];
    results.push({ g, c, dom, agrees });
    s2.addRow([g, c.type, dom, agrees, ranked.map(([t, n]) => `${t} ${n}`).join(", "), pr ? pr.items.size : 0, pr ? [...pr.items].sort().slice(0, 8).join(", ") : "(not attached to any item)", pr ? [...pr.menus].sort().join(" | ") : ""]);
  }
  await wb.xlsx.writeFile(FILE);
  const review = results.filter((r) => r.agrees === "REVIEW");
  console.log(`updated: ${FILE}\nitem-group links (distinct names): ${links.length}; groups checked: ${results.length}; agree: ${results.filter((r) => r.agrees === "Yes").length}; n/a: ${results.filter((r) => r.agrees === "n/a").length}; REVIEW: ${review.length}`);
  for (const r of review) console.log(`  REVIEW ${r.g}  name-type=${r.c.type}  options-suggest=${r.dom}`);
  const orphan = groupsAll.filter((g) => !parents[g]);
  console.log(`groups not attached to any item: ${orphan.length}${orphan.length ? " -> " + orphan.slice(0, 8).join(" | ") : ""}`);
  await pool.end();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
