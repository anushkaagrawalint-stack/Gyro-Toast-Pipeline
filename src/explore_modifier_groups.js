// Lists every modifier group (menus API) with locations, usage in orders and the options it contains.
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = (await p.query(`
    WITH g AS (SELECT modifier_group_name n, count(DISTINCT store_location_id) locs, max(modifier_group_min_selections) mn, max(modifier_group_max_selections) mx
               FROM input.in_menus_modifier_group_refs WHERE modifier_group_name IS NOT NULL GROUP BY 1),
    o AS (SELECT r.modifier_group_name n, string_agg(DISTINCT x.modifier_option_name, ', ') opts
          FROM input.in_menus_modifier_group_refs r
          JOIN input.in_menus_modifier_group_option_ref l ON l.store_location_id=r.store_location_id AND l.modifier_group_reference_key=r.modifier_group_reference_key
          JOIN input.in_config_modifier_option x ON x.store_location_id=l.store_location_id AND x.modifier_option_reference_key::text=l.modifier_option_reference_id::text
          GROUP BY 1),
    u AS (SELECT modifier_group_name n, count(*) used, round(sum(modifier_price_before_discount),2) rev FROM drv.drv_modifier WHERE modifier_group_name IS NOT NULL GROUP BY 1)
    SELECT g.*, coalesce(u.used,0) used, coalesce(u.rev,0) rev, left(coalesce(o.opts,''),90) opts FROM g LEFT JOIN u USING (n) LEFT JOIN o USING (n) ORDER BY g.n`)).rows;
  for (const x of r) console.log(`${x.n.padEnd(50)} L${x.locs} min${x.mn}/max${x.mx} used=${String(x.used).padStart(5)} $${x.rev} | ${x.opts}`);
  await p.end();
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
