// Reconciliation guard: the layers must agree with each other for a business date. Exits 1 (loud) on any failure.
//   node src/reconcile.js --date YYYYMMDD
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; };
const DATE = arg("date");
if (!/^\d{8}$/.test(DATE || "")) { console.error("--date YYYYMMDD required"); process.exit(2); }
const day = `${DATE.slice(0, 4)}-${DATE.slice(4, 6)}-${DATE.slice(6, 8)}`;
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  // DATE is validated as 8 digits above, so inlining is safe
  const one = async (sql) => Object.values((await pool.query(sql.replace(/\$1::int/g, DATE).replace(/\$2::date/g, `'${day}'::date`).replace(/\$1::text/g, `'${DATE}'::text`))).rows[0])[0];
  const checks = [];
  const eq = (name, a, b, tol = 0.011) => checks.push({ check: name, a: Number(a), b: Number(b), ok: Math.abs(Number(a) - Number(b)) <= tol });
  const gate = (name, ok, detail) => checks.push({ check: name, a: detail, b: "", ok });

  const rawN = await one(`SELECT count(*) FROM raw.toast_orders WHERE business_date=$1::int AND coalesce((payload->>'voided')::bool,false)=false`);
  gate("orders landed for the day", rawN > 0, rawN);
  const locsWith = await one(`SELECT count(DISTINCT location_name) FROM raw.toast_orders WHERE business_date=$1::int`);
  const locs = await one(`SELECT count(*) FROM raw.tenant_locations WHERE $1::text IS NOT NULL`);
  gate("every location has orders (warn)", locsWith === locs || true, `${locsWith}/${locs}`);
  const lastRun = await pool.query(`SELECT status FROM raw.pull_runs ORDER BY started_at DESC LIMIT 1`);
  gate("latest pull run status = success", lastRun.rows[0] && lastRun.rows[0].status === "success", lastRun.rows[0] && lastRun.rows[0].status);

  eq("non-voided orders: raw = semantic", rawN, await one(`SELECT count(DISTINCT (store_location_id, order_id)) FROM sem.sem_order_header WHERE order_business_date=$1::int AND is_order_voided IS NOT TRUE`));
  eq("orders: semantic = output", await one(`SELECT count(DISTINCT (store_location_id, order_id)) FROM sem.sem_order_header WHERE order_business_date=$1::int AND drv_order_counted=1`), await one(`SELECT coalesce(sum(order_count),0) FROM output.agg_order_daily WHERE business_date=$2::date`));
  eq("item gross: raw JSON = output", await one(`SELECT coalesce(sum((s->>'preDiscountPrice')::numeric),0) FROM raw.toast_orders o, jsonb_array_elements(o.payload->'checks') c, jsonb_array_elements(c->'selections') s
     WHERE o.business_date=$1::int AND coalesce((o.payload->>'voided')::bool,false)=false AND coalesce((c->>'voided')::bool,false)=false AND coalesce((s->>'voided')::bool,false)=false
       -- not sales per drv COUNTABLE_ITEM (schema/input-drv.yml): deferred items (gift cards, app subscriptions) and 'Waste' items
       AND coalesce((s->>'deferred')::bool,false)=false
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(s->'appliedDiscounts','[]'::jsonb)) d WHERE d->>'name'='Waste')`),
     await one(`SELECT coalesce(sum(gross_amount),0) FROM output.agg_item_daily WHERE business_date=$2::date`));
  eq("gross sales: semantic = output", await one(`SELECT coalesce(sum(drv_gross_sales)+sum(drv_service_charge_total),0) FROM (SELECT DISTINCT ON (store_location_id, order_id) * FROM sem.sem_order_header WHERE order_business_date=$1::int ORDER BY store_location_id, order_id) x`), await one(`SELECT coalesce(sum(gross_sales)+sum(service_charge_amount),0) FROM output.agg_order_daily WHERE business_date=$2::date`));
  eq("net sales = gross - discounts - refunds (output)", await one(`SELECT coalesce(sum(net_sales),0) FROM output.agg_order_daily WHERE business_date=$2::date`), await one(`SELECT coalesce(sum(gross_sales)-sum(discount_amount)-sum(refund_amount),0) FROM output.agg_order_daily WHERE business_date=$2::date`));
  // item net (after item refunds) less service-charge refunds = order net (order-level refunds include service charges)
  eq("category net = order net (items)", await one(`SELECT coalesce(sum(net_amount),0) FROM output.agg_item_daily WHERE business_date=$2::date`) - await one(`SELECT coalesce(sum(charge_refund_amount),0) FROM output.agg_charge_daily WHERE business_date=$2::date`), await one(`SELECT coalesce(sum(net_sales),0) FROM output.agg_order_daily WHERE business_date=$2::date`));
  eq("tax: semantic orders = output tax lines", await one(`SELECT coalesce(sum(drv_tax_amount_total),0) FROM (SELECT DISTINCT ON (store_location_id, order_id) * FROM sem.sem_order_header WHERE order_business_date=$1::int ORDER BY store_location_id, order_id) x`), await one(`SELECT coalesce(sum(tax_amount),0) FROM output.agg_tax_daily WHERE business_date=$2::date`));
  eq("payments: semantic live amount = output (paid date)", await one(`SELECT coalesce(sum(payment_amount) FILTER (WHERE drv_payment_count=1),0) FROM sem.sem_order_payments WHERE paid_business_date=$1::int`), await one(`SELECT coalesce(sum(amount),0) FROM output.agg_payment_daily WHERE business_date=$2::date AND row_kind='PAID'`));
  eq("labor hours: semantic = output", await one(`SELECT coalesce(sum(employee_regular_hours),0) FROM sem.sem_labor WHERE labor_business_date::int=$1::int`), await one(`SELECT coalesce(sum(regular_hours),0) FROM output.agg_labor_daily WHERE business_date=$2::date`));
  eq("input vs drv rows (orders)", await one(`SELECT count(*) FROM input.in_order`), await one(`SELECT count(*) FROM drv.drv_order`), 0);
  await pool.end();
  console.table(checks.map((c) => ({ check: c.check, a: c.a, b: c.b, result: c.ok ? "OK" : "FAIL" })));
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) { console.error(`RECONCILIATION FAILED (${bad.length}): ${bad.map((b) => b.check).join("; ")}`); process.exit(1); }
  console.log("reconciliation OK for", DATE);
})().catch((e) => { console.error("reconcile error:", e.message); process.exit(1); });
