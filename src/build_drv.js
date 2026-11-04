// Builds the derived layer (schema "drv", drv_* tables) from the input layer, driven by
// schema/input-drv.yml.  Rebuilt from scratch each run (tables).
//   node src/build_drv.js
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { Pool } = require("pg");

const DRV = yaml.load(fs.readFileSync(path.join(__dirname, "../schema/input-drv.yml"), "utf8"));
const INSPEC = yaml.load(fs.readFileSync(path.join(__dirname, "../schema/raw-input.yaml"), "utf8"));

const ORDER_T = ["order", "order_pricing_feature", "check", "service_charge", "items", "modifier", "payment", "tax", "discount", "discount_combo_item", "discount_trigger_item"];
const inScope = (n) => ORDER_T.includes(n.replace(/^drv_/, "")) || /^drv_(config|menus|labor)/.test(n);
const MODELS = DRV.models.filter((m) => inScope(m.name));

const first = (n) => n.split("/")[0].trim();
const PG = { STRING: "text", NUMERIC: "numeric", INT64: "bigint", BOOL: "boolean", BOOLEAN: "boolean", TIMESTAMP: "timestamptz", DATE: "date", FLOAT64: "double precision", INT: "bigint" };
const pgType = (t) => PG[(t || "STRING").toUpperCase()] || "text";
const LIN = ["organisation_id", "organisation_slug", "tenant_id", "tenant_slug", "store_location_id", "tenant_location_id", "store_timezone",
  "system_id", "system_slug", "source_id", "source_slug", "source_timezone", "source_entity_id", "entity_name", "_run_id", "_extracted_at", "_source_type", "_load_mode"];
const q = (s) => '"' + s.replace(/"/g, '""') + '"';

// ---------- shared rule snippets (alias t = current row) ---------------------------------
const SAME = (a, k) => `${a}.store_location_id = t.store_location_id AND ${a}.${k} = t.${k}`;
const LIVE_CHECK_OF = (col) => `EXISTS (SELECT 1 FROM drv.h_live_check h WHERE h.store_location_id=t.store_location_id AND h.check_id=t.${col})`;
const LIVE_ITEM_OF = (col) => `EXISTS (SELECT 1 FROM drv.h_live_item h WHERE h.store_location_id=t.store_location_id AND h.item_id=t.${col})`;
const COUNT_ITEM_OF = (col) => `EXISTS (SELECT 1 FROM drv.h_countable_item h WHERE h.store_location_id=t.store_location_id AND h.item_id=t.${col})`;
const WASTE_OF = (col) => `EXISTS (SELECT 1 FROM drv.h_waste_item h WHERE h.store_location_id=t.store_location_id AND h.item_id=t.${col})`;
const LD = (d) => `coalesce(${d}.discount_name,'')<>'Waste' AND coalesce(${d}.processing_state,'')<>'VOID'`;
const LIVE_PAY = (p) => `${p}.payment_status IN ('CAPTURED','AUTHORIZED')`;
const ITEM_TAXES = (a, col = "item_id") => `${a}.store_location_id=t.store_location_id AND ${a}.item_id=t.${col} AND ${a}.modifier_id IS NULL AND ${a}.check_service_charge_id IS NULL`;
const SEQ = (x) => `nullif(${x},'')::int`;
const REFUND_DATE = (orderCol, rtCol) =>
  `(SELECT p.payment_refund_business_date FROM input.in_payment p WHERE p.store_location_id=t.store_location_id AND p.order_id=t.${orderCol} AND p.refund_transaction_id=t.${rtCol} ORDER BY ${SEQ("p.payment_sequence")} LIMIT 1)`;

// ---------- calculated columns: [name, level, sql] ---------------------------------------
const CALC = {
  drv_check: [
    ["drv_service_charge", 0, `CASE WHEN ${LIVE_CHECK_OF("check_id")} THEN coalesce((SELECT sum(s.service_charge_amount) FROM input.in_service_charge s WHERE ${SAME("s", "check_id")}),0) ELSE 0 END`],
    ["drv_discount", 0, `CASE WHEN ${LIVE_CHECK_OF("check_id")} THEN coalesce((SELECT sum(d.discount_amount) FROM input.in_discount d WHERE ${SAME("d", "check_id")} AND d.item_id IS NULL AND d.modifier_id IS NULL AND ${LD("d")}),0) ELSE 0 END`],
  ],
  drv_items: [
    ["drv_gross_sales", 0, `CASE WHEN ${COUNT_ITEM_OF("item_id")} THEN t.item_price_before_discount ELSE 0 END`],
    ["drv_discount", 0, `CASE WHEN ${LIVE_ITEM_OF("item_id")} AND NOT ${WASTE_OF("item_id")} THEN coalesce((SELECT sum(d.discount_amount) FROM input.in_discount d WHERE ${SAME("d", "item_id")} AND d.modifier_id IS NULL AND ${LD("d")}),0) ELSE 0 END`],
    ["drv_refund_tax", 0, `CASE WHEN ${LIVE_ITEM_OF("item_id")} THEN t.items_refund_tax_amount ELSE 0 END`],
    ["drv_refund_date", 0, `CASE WHEN coalesce(t.items_refund_amount,0)>0 OR coalesce(t.items_refund_tax_amount,0)>0 THEN ${REFUND_DATE("order_id", "item_refund_transaction_id")} END`],
    ["drv_is_reportable_sales_category", 0, `CASE WHEN t.sales_category_name IN ('Taxes','Donation') THEN false ELSE true END`],
    ["drv_deferred_amount", 0, `CASE WHEN t.item_is_deferred IS TRUE AND ${LIVE_ITEM_OF("item_id")} THEN t.item_price_before_discount ELSE 0 END`],
    ["drv_facilitator_base", 0, `CASE WHEN ${COUNT_ITEM_OF("item_id")} AND EXISTS (SELECT 1 FROM input.in_tax tx WHERE ${ITEM_TAXES("tx")} AND tx.is_tax_marketplace_remitted IS TRUE) THEN t.item_price_before_discount ELSE 0 END`],
    ["drv_countable_quantity", 0, `CASE WHEN ${COUNT_ITEM_OF("item_id")} THEN t.item_quantity ELSE 0 END`],
    ["drv_countable_tax_amount", 0, `CASE WHEN ${COUNT_ITEM_OF("item_id")} THEN coalesce((SELECT sum(tx.tax_amount) FROM input.in_tax tx WHERE ${ITEM_TAXES("tx")}),0) ELSE 0 END`],
    ["drv_is_open_item", 0, `CASE WHEN t.item_type='OPEN_ITEM' THEN 1 ELSE 0 END`],
    ["drv_sales_status", 0, `CASE WHEN NOT ${LIVE_ITEM_OF("item_id")} THEN 'VOIDED' WHEN ${WASTE_OF("item_id")} THEN 'WASTE' WHEN t.item_is_deferred IS TRUE THEN 'DEFERRED' ELSE 'SOLD' END`],
    ["drv_net_sales", 1, `t.drv_gross_sales - t.drv_discount`],
    // item_unit_price is present on every line in this data; the "line has no price" pool-allocation branch is not needed (0).
    ["drv_check_discount_allocation", 1, `CASE WHEN NOT ${COUNT_ITEM_OF("item_id")} THEN 0 WHEN t.item_unit_price IS NOT NULL THEN round(t.item_price_before_discount - t.item_unit_price - t.drv_discount, 2) ELSE 0 END`],
    ["drv_discount_incl_check_share", 2, `CASE WHEN ${COUNT_ITEM_OF("item_id")} THEN t.drv_discount + t.drv_check_discount_allocation ELSE 0 END`],
    ["drv_nontaxable_base", 2, `CASE WHEN ${COUNT_ITEM_OF("item_id")} AND NOT EXISTS (SELECT 1 FROM input.in_tax tx WHERE ${ITEM_TAXES("tx")} AND tx.tax_amount>0) THEN t.item_price_before_discount - t.drv_discount - t.drv_check_discount_allocation ELSE 0 END`],
  ],
  drv_service_charge: [
    ["drv_live_charge_amount", 0, `CASE WHEN ${LIVE_CHECK_OF("check_id")} THEN t.service_charge_amount ELSE 0 END`],
    ["drv_charge_refund_date", 0, `CASE WHEN coalesce(t.service_charge_refund_transaction_id,'')<>'' THEN ${REFUND_DATE("order_id", "service_charge_refund_transaction_id")} END`],
    ["drv_charge_tax_amount", 0, `CASE WHEN ${LIVE_CHECK_OF("check_id")} THEN coalesce((SELECT sum(tx.tax_amount) FROM input.in_tax tx WHERE tx.store_location_id=t.store_location_id AND tx.check_service_charge_id=t.check_service_charge_id AND tx.tax_type IS DISTINCT FROM 'EXTERNAL'),0) ELSE 0 END`],
    ["drv_charge_tax_name", 0, `(SELECT tx.tax_name FROM input.in_tax tx WHERE tx.store_location_id=t.store_location_id AND tx.check_service_charge_id=t.check_service_charge_id AND tx.tax_type IS DISTINCT FROM 'EXTERNAL' ORDER BY ${SEQ("tx.appliedtaxes_sequence")} LIMIT 1)`],
    ["drv_charge_external_tax_amount", 0, `CASE WHEN ${LIVE_CHECK_OF("check_id")} THEN coalesce((SELECT sum(tx.tax_amount) FROM input.in_tax tx WHERE tx.store_location_id=t.store_location_id AND tx.check_service_charge_id=t.check_service_charge_id AND tx.tax_type = 'EXTERNAL'),0) ELSE 0 END`],
    ["drv_charge_taxable_amount", 1, `CASE WHEN t.drv_charge_tax_amount > 0 THEN t.drv_live_charge_amount ELSE 0 END`],
  ],
  drv_modifier: [
    ["drv_sales_status", 0, `CASE WHEN t.is_voided IS TRUE THEN 'VOIDED' ELSE (SELECT di.drv_sales_status FROM drv.drv_items di WHERE di.store_location_id=t.store_location_id AND di.item_id=t.item_id) END`],
  ],
  drv_payment: [
    ["drv_tips", 0, `CASE WHEN t.payment_status='CAPTURED' THEN t.payment_tip_amount ELSE 0 END`],
    ["drv_refund_net", 0, `CASE WHEN t.payment_status IS DISTINCT FROM 'VOIDED' AND t.payment_refund_amount IS NOT NULL THEN t.payment_refund_amount ELSE 0 END`],
    ["drv_tip_refund", 0, `CASE WHEN t.payment_status IS DISTINCT FROM 'VOIDED' AND t.payment_refund_amount IS NOT NULL THEN t.payment_refund_tip_amount ELSE 0 END`],
    ["drv_is_captured", 0, `CASE WHEN t.payment_status='CAPTURED' THEN 1 ELSE 0 END`],
    ["drv_payment_count", 0, `CASE WHEN ${LIVE_PAY("t")} THEN 1 ELSE 0 END`],
    ["drv_payment_type_group", 0, `CASE t.payment_type WHEN 'CREDIT' THEN 'Credit/debit' WHEN 'CASH' THEN 'Cash' WHEN 'GIFTCARD' THEN 'Gift Card' WHEN 'OTHER' THEN 'Other' ELSE t.payment_type END`],
    ["drv_payment_sub_type", 0, `CASE WHEN coalesce(t.card_type,'')<>'' THEN t.card_type WHEN coalesce(t.other_payment_name,'')<>'' THEN t.other_payment_name END`],
    ["drv_payment_tax_amount", 0, `CASE WHEN ${LIVE_CHECK_OF("check_id")} AND ${LIVE_PAY("t")} THEN coalesce((SELECT c.check_tax_amount FROM input.in_check c WHERE ${SAME("c", "check_id")}) * t.payment_amount / nullif((SELECT sum(p2.payment_amount) FROM input.in_payment p2 WHERE ${SAME("p2", "check_id")} AND ${LIVE_PAY("p2")}),0),0) ELSE 0 END`],
    ["drv_refund_tax_amount", 0, `CASE WHEN t.payment_refund_amount IS NOT NULL THEN coalesce((SELECT sum(i.items_refund_tax_amount) FROM input.in_items i WHERE i.store_location_id=t.store_location_id AND i.order_id=t.order_id AND i.item_refund_transaction_id=t.refund_transaction_id),0) ELSE 0 END`],
    ["drv_paid_in_advance_amount", 0, `CASE WHEN ${LIVE_PAY("t")} AND t.paid_business_date < (SELECT o.order_business_date FROM input.in_order o WHERE ${SAME("o", "order_id")}) THEN t.payment_amount + t.payment_tip_amount ELSE 0 END`],
    ["drv_gratuity_amount", 0, `CASE WHEN ${LIVE_PAY("t")} THEN coalesce((SELECT sum(s.service_charge_amount) FROM input.in_service_charge s WHERE ${SAME("s", "check_id")} AND s.is_check_service_charge_gratuity IS TRUE AND s.check_service_charge_payment_id = t.payment_id),0) + coalesce((SELECT sum(s.service_charge_amount) FROM input.in_service_charge s WHERE ${SAME("s", "check_id")} AND s.is_check_service_charge_gratuity IS TRUE AND coalesce(s.check_service_charge_payment_id,'')='') * t.payment_amount / nullif((SELECT sum(p2.payment_amount) FROM input.in_payment p2 WHERE ${SAME("p2", "check_id")} AND ${LIVE_PAY("p2")}),0),0) ELSE 0 END`],
    ["drv_refund_net_of_tax", 1, `t.drv_refund_net - t.drv_refund_tax_amount`],
    ["drv_refund_and_tip_amount", 1, `CASE WHEN t.payment_refund_amount IS NOT NULL THEN t.drv_refund_net + t.drv_tip_refund ELSE 0 END`],
    ["_cr_v", 1, `CASE WHEN t.refund_transaction_id IS NOT NULL THEN
        coalesce(sum(t.payment_refund_amount) OVER (PARTITION BY t.store_location_id, t.refund_transaction_id),0)
      - coalesce((SELECT sum(i.items_refund_amount) FROM input.in_items i WHERE i.store_location_id=t.store_location_id AND i.item_refund_transaction_id=t.refund_transaction_id),0)
      - coalesce((SELECT sum(s.service_charge_refund_amount) FROM input.in_service_charge s WHERE s.store_location_id=t.store_location_id AND s.service_charge_refund_transaction_id=t.refund_transaction_id),0)
      - coalesce(sum(t.drv_refund_tax_amount) OVER (PARTITION BY t.store_location_id, t.refund_transaction_id),0) END`],
    ["_cr_rn", 1, `CASE WHEN t.refund_transaction_id IS NOT NULL THEN row_number() OVER (PARTITION BY t.store_location_id, t.refund_transaction_id ORDER BY ${SEQ("t.payment_sequence")}) END`],
    ["drv_custom_refund_amount", 2, `CASE WHEN t._cr_rn = 1 AND t._cr_v > 0 THEN t._cr_v ELSE 0 END`],
  ],
  drv_tax: [
    ["drv_tax_jurisdiction_amount", 0, `CASE WHEN t.item_id IS NOT NULL AND t.modifier_id IS NULL AND t.check_service_charge_id IS NULL AND ${LIVE_ITEM_OF("item_id")} THEN t.tax_amount ELSE 0 END`],
    ["_di", 0, `(SELECT to_jsonb(di) FROM drv.drv_items di WHERE di.store_location_id=t.store_location_id AND di.item_id=t.item_id)`],
    ["_first_ext", 0, `CASE WHEN t.tax_type='EXTERNAL' THEN t.appliedtaxes_sequence::int = (SELECT min(${SEQ("x.appliedtaxes_sequence")}) FROM input.in_tax x WHERE ${ITEM_TAXES("x")} AND x.tax_type='EXTERNAL' AND x.tax_amount>0 AND x.is_tax_marketplace_remitted IS NOT DISTINCT FROM t.is_tax_marketplace_remitted) ELSE true END`],
    ["drv_taxable_amount", 1, `CASE WHEN t.item_id IS NOT NULL AND t.modifier_id IS NULL AND t.check_service_charge_id IS NULL AND ${COUNT_ITEM_OF("item_id")} AND t.tax_amount>0 AND t._first_ext THEN (t._di->>'item_price_before_discount')::numeric - (t._di->>'drv_discount')::numeric - (t._di->>'drv_check_discount_allocation')::numeric ELSE 0 END`],
    ["drv_tax_refund_amount", 1, `CASE WHEN t.item_id IS NOT NULL AND t.modifier_id IS NULL AND t.check_service_charge_id IS NULL THEN coalesce((SELECT i.items_refund_tax_amount FROM input.in_items i WHERE ${SAME("i", "item_id")}) * t.tax_amount / nullif((SELECT sum(x.tax_amount) FROM input.in_tax x WHERE ${ITEM_TAXES("x")}),0),0) ELSE 0 END`],
    ["drv_tax_refund_date", 2, `CASE WHEN t.drv_tax_refund_amount>0 OR (${COUNT_ITEM_OF("item_id")} AND coalesce((SELECT i.items_refund_amount FROM input.in_items i WHERE ${SAME("i", "item_id")}),0)>0 AND t.tax_amount=0) THEN (SELECT p.payment_refund_business_date FROM input.in_payment p JOIN input.in_items i ON i.store_location_id=p.store_location_id AND i.order_id=p.order_id AND i.item_refund_transaction_id=p.refund_transaction_id WHERE i.store_location_id=t.store_location_id AND i.item_id=t.item_id LIMIT 1) END`],
    ["drv_taxable_refund_amount", 2, `CASE WHEN t.drv_tax_refund_amount>0 THEN t.drv_taxable_amount WHEN ${COUNT_ITEM_OF("item_id")} AND coalesce((SELECT i.items_refund_amount FROM input.in_items i WHERE ${SAME("i", "item_id")}),0)>0 AND t.tax_amount=0 THEN (SELECT i.items_refund_amount FROM input.in_items i WHERE ${SAME("i", "item_id")}) ELSE 0 END`],
  ],
  drv_discount: [
    ["drv_is_live_discount", 0, `CASE WHEN ${LD("t")} AND ((t.item_id IS NULL AND ${LIVE_CHECK_OF("check_id")}) OR (t.item_id IS NOT NULL AND ${COUNT_ITEM_OF("item_id")})) THEN 1 ELSE 0 END`],
    ["_chk_seq", 0, `(SELECT ${SEQ("c.check_sequence")} FROM input.in_check c WHERE ${SAME("c", "check_id")})`],
    ["drv_discount", 1, `CASE WHEN t.drv_is_live_discount=1 THEN t.discount_amount ELSE 0 END`],
    ["drv_discount_order_flag", 1, `CASE WHEN t.drv_is_live_discount=1 AND row_number() OVER (PARTITION BY t.store_location_id, t.order_id, (t.item_id IS NULL), t.discount_name, t.drv_is_live_discount ORDER BY t._chk_seq, ${SEQ("t.source_array_index")}) = 1 THEN 1 ELSE 0 END`],
  ],
  drv_order: [
    ["drv_order_counted", 0, `CASE WHEN EXISTS (SELECT 1 FROM drv.h_live_order h WHERE ${SAME("h", "order_id")}) AND t.guest_count>=1 THEN 1 ELSE 0 END`],
    ["drv_order_day_of_week", 0, `trim(to_char(to_date(t.order_business_date::text,'YYYYMMDD'),'Day'))`],
    ["drv_hour_order_opened_at", 0, `extract(hour FROM (t.order_opened_at AT TIME ZONE t.store_timezone))::int`],
    ["drv_gross_sales", 0, `coalesce((SELECT sum(x.drv_gross_sales) FROM drv.drv_items x WHERE ${SAME("x", "order_id")}),0)`],
    ["drv_item_discount_total", 0, `coalesce((SELECT sum(x.drv_discount) FROM drv.drv_items x WHERE ${SAME("x", "order_id")}),0)`],
    ["_chk_disc", 0, `coalesce((SELECT sum(x.drv_discount) FROM drv.drv_check x WHERE ${SAME("x", "order_id")}),0)`],
    ["drv_refund_amount", 0, `coalesce((SELECT sum(x.drv_refund_net) FROM drv.drv_payment x WHERE ${SAME("x", "order_id")}),0) - coalesce((SELECT sum(i.items_refund_tax_amount) FROM input.in_items i WHERE ${SAME("i", "order_id")}),0)`],
    ["drv_tip_amount", 0, `coalesce((SELECT sum(x.drv_tips) FROM drv.drv_payment x WHERE ${SAME("x", "order_id")}),0)`],
    ["drv_service_charge_total", 0, `coalesce((SELECT sum(x.drv_service_charge) FROM drv.drv_check x WHERE ${SAME("x", "order_id")}),0)`],
    ["drv_tax_amount_total", 0, `coalesce((SELECT sum(c.check_tax_amount) FROM input.in_check c JOIN drv.h_live_check h ON h.store_location_id=c.store_location_id AND h.check_id=c.check_id WHERE ${SAME("c", "order_id")}),0)`],
    ["drv_gross_sales_including_voided", 0, `coalesce((SELECT sum(i.item_price_before_discount) FROM input.in_items i WHERE ${SAME("i", "order_id")}),0)`],
    ["drv_has_voided_item", 0, `CASE WHEN EXISTS (SELECT 1 FROM input.in_items i WHERE ${SAME("i", "order_id")} AND i.is_item_voided IS TRUE) THEN 1 ELSE 0 END`],
    ["drv_unpaid_amount", 0, `coalesce((SELECT sum(c.check_total_amount - coalesce((SELECT sum(p.payment_amount + coalesce(p.payment_tip_amount,0)) FROM input.in_payment p WHERE p.store_location_id=c.store_location_id AND p.check_id=c.check_id AND ${LIVE_PAY("p")}),0))
      FROM input.in_check c JOIN drv.h_live_check h ON h.store_location_id=c.store_location_id AND h.check_id=c.check_id WHERE ${SAME("c", "order_id")} AND c.check_payment_status='OPEN'),0)`],  // balance still owed (schema text: whole open check total)
    ["drv_discount_amount_total", 1, `t._chk_disc + t.drv_item_discount_total`],
    ["drv_net_sales", 2, `t.drv_gross_sales - t.drv_discount_amount_total - t.drv_refund_amount`],
  ],
};

// ---------- main ---------------------------------------------------------------------------
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const run = (await pool.query("select run_id::text, finished_at from raw.pull_runs where status='success' order by started_at desc limit 1")).rows[0];
  const have = {};
  for (const r of (await pool.query("select table_name, column_name from information_schema.columns where table_schema='input'")).rows) (have[r.table_name] ??= new Set()).add(r.column_name);
  const warn = [];

  await pool.query("DROP SCHEMA IF EXISTS drv CASCADE; CREATE SCHEMA drv;");
  for (const [t, cols] of [["in_items", ["order_id", "item_id", "check_id"]], ["in_discount", ["item_id", "check_id", "order_id"]], ["in_tax", ["item_id", "check_service_charge_id"]],
    ["in_payment", ["order_id", "check_id", "refund_transaction_id"]], ["in_check", ["order_id", "check_id"]], ["in_service_charge", ["check_id", "order_id"]], ["in_order", ["order_id"]]])
    for (const c of cols) if (have[t] && have[t].has(c)) await pool.query(`CREATE INDEX IF NOT EXISTS ix_${t}_${c} ON input.${t} (store_location_id, ${q(c)})`);

  // lineage lookup (generated: Gyro / tenants / Toast)
  await pool.query(`
    CREATE TABLE drv.lineage AS
    SELECT tl.location_name AS store_location_id,
      md5('organisation:gyro')::uuid::text AS organisation_id, 'gyro' AS organisation_slug,
      md5('tenant:'||tl.tenant)::uuid::text AS tenant_id, lower(regexp_replace(tl.tenant,'[^a-zA-Z0-9]+','-','g')) AS tenant_slug,
      lower(regexp_replace(tl.tenant,'[^a-zA-Z0-9]+','-','g')) || '/' || lower(regexp_replace(tl.location_name,'[^a-zA-Z0-9]+','-','g')) AS tenant_location_id,
      coalesce((SELECT a.payload->'general'->>'timeZone' FROM raw.api_responses a WHERE a.location_guid=tl.location_guid
         AND a.endpoint LIKE '/restaurants/v1/restaurants/%' AND a.http_status=200 ORDER BY a.id DESC LIMIT 1),'America/Chicago') AS store_timezone,
      md5('system:toast')::uuid::text AS system_id, 'toast' AS system_slug,
      md5('source:toast-api')::uuid::text AS source_id, 'toast-api' AS source_slug, 'UTC' AS source_timezone
    FROM raw.tenant_locations tl`);

  // helper sets for the shared rules
  await pool.query(`
    CREATE TABLE drv.h_live_order AS SELECT store_location_id, order_id FROM input.in_order WHERE is_order_voided IS NOT TRUE;
    CREATE TABLE drv.h_live_check AS SELECT c.store_location_id, c.check_id, c.order_id FROM input.in_check c
      JOIN drv.h_live_order o ON o.store_location_id=c.store_location_id AND o.order_id=c.order_id
      WHERE c.is_check_voided IS NOT TRUE AND c.is_check_deleted IS NOT TRUE;
    CREATE TABLE drv.h_waste_item AS SELECT DISTINCT d.store_location_id, d.item_id FROM input.in_discount d
      WHERE d.item_id IS NOT NULL AND d.modifier_id IS NULL AND d.discount_name='Waste';
    CREATE TABLE drv.h_live_item AS SELECT i.store_location_id, i.item_id, i.check_id, i.order_id FROM input.in_items i
      JOIN drv.h_live_check c ON c.store_location_id=i.store_location_id AND c.check_id=i.check_id WHERE i.is_item_voided IS NOT TRUE;
    CREATE TABLE drv.h_countable_item AS SELECT li.* FROM drv.h_live_item li
      JOIN input.in_items i ON i.store_location_id=li.store_location_id AND i.item_id=li.item_id
      WHERE i.item_is_deferred IS NOT TRUE
        AND NOT EXISTS (SELECT 1 FROM drv.h_waste_item w WHERE w.store_location_id=li.store_location_id AND w.item_id=li.item_id);
  `);

  for (const h of ["h_live_order:order_id", "h_live_check:check_id", "h_waste_item:item_id", "h_live_item:item_id", "h_countable_item:item_id"]) {
    const [t, c] = h.split(":"); await pool.query(`CREATE INDEX ON drv.${t} (store_location_id, ${c})`);
  }
  const ORDER = ["drv_check", "drv_items", "drv_service_charge", "drv_payment", "drv_tax", "drv_modifier", "drv_discount", "drv_order"];
  const names = MODELS.map((m) => m.name);
  const sequence = [...ORDER.filter((n) => names.includes(n)), ...names.filter((n) => !ORDER.includes(n) && n !== "drv_labor"), "drv_labor"];
  const byName = Object.fromEntries(MODELS.map((m) => [m.name, m]));
  const counts = {};

  for (const name of sequence) {
    const m = byName[name];
    if (name === "drv_labor") { await buildLabor(pool, m, run, have, warn); counts[name] = (await pool.query("select count(*) n from drv.drv_labor")).rows[0].n; continue; }
    const inT = name.replace(/^drv_/, "in_");
    const entity = (INSPEC[inT] && INSPEC[inT].source_entity) || "menus";
    const sel = [], joins = [], mjGroups = {};
    for (const c of m.columns) {
      const kind = c.meta.kind;
      const cn = first(c.name);
      if (/calculated/.test(kind)) continue;
      if (kind === "lineage" && LIN.includes(c.name)) {
        const lin = {
          _run_id: `'${run.run_id}'`, _extracted_at: `'${new Date(run.finished_at).toISOString()}'::timestamptz`, _source_type: `'api'`, _load_mode: `'full'`,
          entity_name: `'${entity}'`, source_entity_id: `md5('entity:${entity}')::uuid::text`,
        }[c.name] || `l.${q(c.name)}`;
        sel.push(`${lin} AS ${q(c.name)}`); continue;
      }
      if (kind === "Mapping join") {
        const [stab, scol] = c.meta.source.split(".");
        let lcol, rcol;
        const jm = (c.meta.join || "").match(/\+\s*(\S+)\s*=\s*\S+?\.(\S+)$/);
        if (jm) { lcol = jm[1]; rcol = jm[2]; } else { lcol = "menu_group_id"; rcol = "menu_group_id"; }
        // schema joins on check_service_charge_id (the applied row's own guid) which never matches; the config guid is service_charge_id
        if (name === "drv_service_charge" && lcol === "check_service_charge_id") lcol = "service_charge_id";
        const key = `${stab}|${lcol}|${rcol}`;
        (mjGroups[key] ??= { stab, lcol, rcol, cols: [] }).cols.push({ out: c.name, src: scol });
        continue;
      }
      // input column (slash-named columns use the first name, as in the input layer)
      if (have[inT] && have[inT].has(cn)) sel.push(`t0.${q(cn)} AS ${q(cn)}`);
      else { sel.push(`NULL::${pgType(c.data_type)} AS ${q(cn)}`); warn.push(`${name}.${cn}: not in ${inT} -> NULL`); }
    }
    let ji = 0;
    for (const g of Object.values(mjGroups)) {
      ji++;
      const ok = have[g.stab] && have[inT] && have[inT].has(g.lcol) && have[g.stab].has(g.rcol) && g.cols.every((x) => have[g.stab].has(x.src));
      if (!ok) { for (const x of g.cols) { sel.push(`NULL::text AS ${q(x.out)}`); warn.push(`${name}.${x.out}: join to ${g.stab} unavailable -> NULL`); } continue; }
      joins.push(`LEFT JOIN (SELECT DISTINCT ON (store_location_id, ${q(g.rcol)}::text) store_location_id, ${q(g.rcol)}::text AS k, ${g.cols.map((x) => `${q(x.src)} AS ${q(x.out)}`).join(", ")}
        FROM input.${g.stab} ORDER BY store_location_id, ${q(g.rcol)}::text) j${ji} ON j${ji}.store_location_id=t0.store_location_id AND j${ji}.k=t0.${q(g.lcol)}::text`);
      for (const x of g.cols) sel.push(`j${ji}.${q(x.out)} AS ${q(x.out)}`);
    }
    let sql = `SELECT ${sel.join(", ")} FROM input.${inT} t0 LEFT JOIN drv.lineage l ON l.store_location_id=t0.store_location_id ${joins.join(" ")}`;
    // calculated levels
    const calcs = CALC[name] || [];
    const declared = m.columns.filter((c) => /calculated/.test(c.meta.kind)).map((c) => c.name);
    for (const d of declared) if (!calcs.find((x) => x[0] === d)) warn.push(`${name}.${d}: calculation not implemented -> NULL`);
    const levels = [...new Set(calcs.map((x) => x[1]))].sort();
    for (const lv of levels) sql = `SELECT t.*, ${calcs.filter((x) => x[1] === lv).map((x) => `(${x[2]}) AS ${q(x[0])}`).join(", ")} FROM (${sql}) t`;
    const finalCols = m.columns.map((c) => {
      const cn = first(c.name);
      return declared.includes(c.name) && !calcs.find((x) => x[0] === c.name) ? `NULL::${pgType(c.data_type)} AS ${q(cn)}` : q(cn);
    });
    try {
      await pool.query(`CREATE TABLE drv.${name} AS SELECT ${finalCols.join(", ")} FROM (${sql}) t`);
    } catch (e) { throw new Error(`${name}: ${e.message}`); }
    for (const c of ["order_id", "item_id", "check_id"]) {
      const has = (await pool.query("select 1 from information_schema.columns where table_schema='drv' and table_name=$1 and column_name=$2", [name, c])).rowCount;
      if (has) await pool.query(`CREATE INDEX ON drv.${name} (store_location_id, ${c})`);
    }
    counts[name] = (await pool.query(`select count(*) n from drv.${name}`)).rows[0].n;
    // row count must equal the input table
    const inN = (await pool.query(`select count(*) n from input.${inT}`)).rows[0].n;
    if (inN !== counts[name]) warn.push(`${name}: ROW COUNT ${counts[name]} != ${inT} ${inN}`);
  }
  console.log(`drv tables built: ${Object.keys(counts).length}`);
  console.table(Object.entries(counts).filter(([, n]) => +n > 0).map(([t, n]) => ({ table: t, rows: +n })));
  console.log("empty:", Object.entries(counts).filter(([, n]) => +n === 0).map(([t]) => t).join(", "));
  console.log("warnings:", warn.length); warn.slice(0, 60).forEach((w) => console.log("  -", w));
  await pool.end();
}

// ---------- drv_labor: shift + employee + job rows ---------------------------------------------
async function buildLabor(pool, m, run, have, warn) {
  const branches = [
    { type: "shift", from: `input.in_labor_time_entry te LEFT JOIN input.in_labor_time_entry_break be ON be.store_location_id=te.store_location_id AND be.time_entry_id=te.time_entry_id
        LEFT JOIN input.in_labor_employee e ON e.store_location_id=te.store_location_id AND e.employee_id=te.employee_id
        LEFT JOIN input.in_labor_job j ON j.store_location_id=te.store_location_id AND j.job_id=te.job_id`, aliases: ["te", "be", "e", "j"], base: "te", entity: "time_entries" },
    { type: "employee", from: `input.in_labor_employee e`, aliases: ["e"], base: "e", entity: "employees" },
    { type: "employee", from: `input.in_labor_employee_wage_override wo JOIN input.in_labor_employee e ON e.store_location_id=wo.store_location_id AND e.employee_id=wo.employee_id`, aliases: ["wo", "e"], base: "e", entity: "employees" },
    { type: "employee", from: `input.in_labor_employee_job ej JOIN input.in_labor_employee e ON e.store_location_id=ej.store_location_id AND e.employee_id=ej.employee_id`, aliases: ["ej", "e"], base: "e", entity: "employees" },
    { type: "job", from: `input.in_labor_job j`, aliases: ["j"], base: "j", entity: "jobs" },
  ];
  const tabOf = { te: "in_labor_time_entry", be: "in_labor_time_entry_break", e: "in_labor_employee", wo: "in_labor_employee_wage_override", ej: "in_labor_employee_job", j: "in_labor_job" };
  const parts = [];
  for (const b of branches) {
    const cols = m.columns.map((c) => {
      const cn = first(c.name);
      if (c.meta.kind === "lineage") {
        return ({ _run_id: `'${run.run_id}'`, _extracted_at: `'${new Date(run.finished_at).toISOString()}'::timestamptz`, _source_type: `'api'`, _load_mode: `'full'`,
          entity_name: `'${b.entity}'`, source_entity_id: `md5('entity:${b.entity}')::uuid::text` }[c.name] || `l.${q(c.name)}`) + ` AS ${q(cn)}`;
      }
      if (cn === "drv_record_type") return `'${b.type}' AS ${q(cn)}`;
      const t = pgType(c.data_type);
      if (c.meta.kind === "calculated drv_" || cn === "employee_name" || cn === "job_title" || cn === "job_code") return `NULL::${t} AS ${q(cn)}`; // filled below
      const a = b.aliases.find((al) => have[tabOf[al]] && have[tabOf[al]].has(cn));
      return a ? `${a}.${q(cn)}::${t} AS ${q(cn)}` : `NULL::${t} AS ${q(cn)}`;
    });
    // store_location_id comes from the base alias
    parts.push(`SELECT ${cols.join(", ")} FROM ${b.from} LEFT JOIN drv.lineage l ON l.store_location_id=${b.base}.store_location_id`);
  }
  // the lineage join above references store_location_id of the base alias; no ambiguity because only l.* is selected
  await pool.query(`CREATE TABLE drv.labor_stage AS ${parts.join(" UNION ALL ")}`);
  const calc = `
    SELECT s.*, 0 AS _x FROM drv.labor_stage s`;
  const final = m.columns.map((c) => {
    const cn = first(c.name), t = pgType(c.data_type);
    const E = {
      employee_name: `(SELECT e.employee_last_name || ', ' || e.employee_first_name FROM input.in_labor_employee e WHERE e.store_location_id=s.store_location_id AND e.employee_id=s.employee_id)`,
      drv_regular_pay: `round(s.employee_regular_hours * s.employee_hourly_wage, 2)`,
      drv_total_sales: `s.time_entry_cash_sales_amount + s.time_entry_non_cash_sales_amount`,
      drv_order_tips_amount: `CASE WHEN s.drv_record_type='shift' THEN coalesce((SELECT sum(p.payment_tip_amount) FROM input.in_payment p WHERE p.store_location_id=s.store_location_id AND p.payment_status='CAPTURED' AND p.server_id=s.employee_id AND p.paid_business_date::text=s.labor_business_date::text),0) END`,
      job_title: `CASE WHEN s.drv_record_type='job' THEN (SELECT j.job_title FROM input.in_labor_job j WHERE j.store_location_id=s.store_location_id AND j.job_id=s.job_id) WHEN s.drv_record_type='shift' THEN (SELECT j.job_title FROM input.in_labor_job j WHERE j.store_location_id=s.store_location_id AND j.job_id=s.job_id) END`,
      job_code: `CASE WHEN s.drv_record_type IN ('job','shift') THEN (SELECT j.job_code FROM input.in_labor_job j WHERE j.store_location_id=s.store_location_id AND j.job_id=s.job_id) END`,
      drv_shift_day_of_week: `CASE WHEN s.drv_record_type='shift' THEN trim(to_char(to_date(s.labor_business_date::text,'YYYYMMDD'),'Day')) END`,
      drv_hour_shift_clock_in_at: `CASE WHEN s.drv_record_type='shift' THEN extract(hour FROM (s.employee_clock_in_at AT TIME ZONE s.store_timezone))::int END`,
    }[cn];
    if (/^drv_(overtime_pay|total_pay)$/.test(cn)) return `NULL::${t} AS ${q(cn)}`;
    return E ? `(${E})::${t} AS ${q(cn)}` : `s.${q(cn)}`;
  });
  try { await pool.query(`CREATE TABLE drv.drv_labor AS SELECT ${final.join(", ")} FROM drv.labor_stage s`); }
  catch (e) { throw new Error("drv_labor: " + e.message); }
  await pool.query("DROP TABLE drv.labor_stage");
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
