// For each modifier group: the modifiers actually sold under it (top 7 by count).
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = (await p.query(`
    SELECT modifier_group_name g, modifier_name m, count(*) n FROM drv.drv_modifier WHERE modifier_group_name IS NOT NULL AND is_voided IS NOT TRUE GROUP BY 1,2`)).rows;
  const by = {};
  for (const x of r) (by[x.g] ??= []).push([x.m, +x.n]);
  for (const g of Object.keys(by).sort()) {
    const l = by[g].sort((a, b) => b[1] - a[1]);
    const tot = l.reduce((s, x) => s + x[1], 0);
    console.log(`${g.padEnd(40)} ${String(tot).padStart(5)} | ${l.slice(0, 7).map((x) => `${x[0]}(${x[1]})`).join(", ").slice(0, 150)}`);
  }
  await p.end();
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
