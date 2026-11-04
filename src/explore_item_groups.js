require("dotenv").config({ quiet: true });
const { Pool } = require("pg");
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const t of ["in_menus_menu_item_modifier_group_ref", "in_menus_menu_items", "in_menus_modifier_group_refs", "in_menus_modifier_group_option_ref", "in_config_modifier_option", "in_menus_modifier_option_modifier_group_ref"]) {
    const c = (await p.query(`select column_name from information_schema.columns where table_schema='input' and table_name=$1 order by ordinal_position`, [t])).rows.map((x) => x.column_name);
    const n = (await p.query(`select count(*) n from input.${t}`)).rows[0].n;
    console.log(`\n${t} (${n} rows):\n  ${c.join(", ")}`);
  }
  await p.end();
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
