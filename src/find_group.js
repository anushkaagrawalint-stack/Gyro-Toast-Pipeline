// Where does a modifier group sit? Usage: node src/find_group.js "<group name>"
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");
(async () => {
  const name = process.argv[2];
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const g = (await p.query(`SELECT count(*) refs, count(DISTINCT store_location_id) locs, max(modifier_group_min_selections) mn, max(modifier_group_max_selections) mx FROM input.in_menus_modifier_group_refs WHERE modifier_group_name=$1`, [name])).rows[0];
  console.log(`group "${name}": ${g.refs} reference(s) in ${g.locs} location(s); min ${g.mn} / max ${g.mx}`);
  const l = (await p.query(`
    SELECT i.menu_name, i.menu_group_name, i.menu_item_name, count(DISTINCT m.store_location_id) locs, string_agg(DISTINCT m.store_location_id, ', ' ORDER BY m.store_location_id) loc_list
    FROM input.in_menus_menu_item_modifier_group_ref m
    JOIN input.in_menus_menu_items i ON i.store_location_id=m.store_location_id AND i.menu_item_id=m.menu_item_id AND i.menu_group_id=m.menu_group_id
    JOIN input.in_menus_modifier_group_refs g ON g.store_location_id=m.store_location_id AND g.modifier_group_reference_key::text=m.modifier_group_reference_id::text
    WHERE g.modifier_group_name=$1 GROUP BY 1,2,3 ORDER BY 1,2,3`, [name])).rows;
  console.log(l.length ? "attached to parent item(s):" : "NOT attached to any menu item (directly)");
  console.table(l);
  // can it be reached through an option (nested group)?
  const n = (await p.query(`
    SELECT o.modifier_option_name option_that_opens_it, count(DISTINCT x.store_location_id) locs
    FROM input.in_menus_modifier_option_modifier_group_ref x
    JOIN input.in_menus_modifier_group_refs g ON g.store_location_id=x.store_location_id AND g.modifier_group_reference_key::text=x.modifier_group_reference_id::text
    JOIN input.in_config_modifier_option o ON o.store_location_id=x.store_location_id AND o.modifier_option_reference_key=x.modifier_option_reference_key
    WHERE g.modifier_group_name=$1 GROUP BY 1`, [name])).rows;
  if (n.length) { console.log("opened from an option of another group:"); console.table(n); }
  const o = (await p.query(`
    SELECT DISTINCT o.modifier_option_name FROM input.in_menus_modifier_group_refs g
    JOIN input.in_menus_modifier_group_option_ref r ON r.store_location_id=g.store_location_id AND r.modifier_group_reference_key=g.modifier_group_reference_key
    JOIN input.in_config_modifier_option o ON o.store_location_id=r.store_location_id AND o.modifier_option_reference_key::text=r.modifier_option_reference_id::text
    WHERE g.modifier_group_name=$1 ORDER BY 1`, [name])).rows.map((x) => x.modifier_option_name);
  console.log("options in the group:", o.join(", "));
  await p.end();
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
