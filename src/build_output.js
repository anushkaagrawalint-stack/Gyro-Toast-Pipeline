// Builds the output layer (schema "output": dim_*, agg_* and reference tables) from the semantic layer (schema "sem").
// Table / column names follow schema/Output_Layer_Schema_output_marts_dev.pdf.
// NOT built here: rpt_* panels, agg_waterfall_daily, panel_* tables (need the panel seed tables, not in the PDF).
//   node src/build_output.js
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");

const K = (t, c) => `output.k(${t}, ${c})`;
const D = (x) => `to_date(${x}::text,'YYYYMMDD')`;
const SC = (a = "i") => `coalesce(${a}.sales_category_name,'No Sales Category Assigned')`;
const NM = (x) => `coalesce(nullif(${x},''),'UNKNOWN')`;
const MD = (a = "i") => `${NM(a + ".modifier_name")}||'|'||coalesce(${a}.modifier_group_name,'')`;
const MI = (a = "i") => `${NM(a + ".menu_name")}||'|'||${NM(a + ".menu_group_name")}||'|'||${NM(a + ".menu_item_name")}`;
const RUN = `(SELECT max(_run_id) FROM sem.sem_order_header)`;
const ASOF = `(SELECT max(_extracted_at) FROM sem.sem_order_header)`;

const STEPS = [
  // ---------------------------------------------------------------- helpers
  ["fn k", `CREATE FUNCTION output.k(t text, c text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT md5(coalesce(t,'')||'|'||coalesce(nullif(c,''),'UNKNOWN')) $$`],
  ["_ord (one row per order)", `CREATE TABLE output._ord AS SELECT DISTINCT ON (store_location_id, order_id) h.*, ${D("h.order_business_date")} AS bd
     FROM sem.sem_order_header h ORDER BY store_location_id, order_id, nullif(h.source_array_index,'')::int NULLS FIRST`],

  // ---------------------------------------------------------------- reference tables
  ["location_attributes", `CREATE TABLE output.location_attributes AS SELECT DISTINCT tenant_id, store_location_id, store_location_id AS store_name,
      'TX'::text AS state_code, 'TX'::text AS tax_jurisdiction, 'USD'::text AS currency_code, 'QUICK_SERVICE'::text AS service_mode, 'Quick Service'::text AS service_mode_label, 'FROM_TOAST_REPORT'::text AS status
      FROM sem.sem_order_header`],
  ["channel_crosswalk", `CREATE TABLE output.channel_crosswalk AS
      SELECT 'toast'::text AS source_system, d.dining_option_name AS source_value,
        CASE d.dining_option_behavior WHEN 'DINE_IN' THEN 'Dine-in' WHEN 'TAKE_OUT' THEN 'Takeout' WHEN 'DELIVERY' THEN 'Delivery' ELSE 'Unknown' END AS fulfillment_mode,
        CASE WHEN d.dining_option_name ~* 'doordash|uber|grubhub' THEN '3PD' WHEN d.dining_option_name ~* 'app' THEN 'First-party app' ELSE 'In-store' END AS sales_channel,
        CASE WHEN d.dining_option_name ~* 'doordash' THEN 'DoorDash' WHEN d.dining_option_name ~* 'uber' THEN 'Uber Eats' WHEN d.dining_option_name ~* 'grubhub' THEN 'Grubhub' END AS partner_brand,
        'INFERRED'::text AS status, d.n AS p7_order_rows
      FROM (SELECT dining_option_name, max(dining_option_behavior) dining_option_behavior, count(*)::bigint n FROM output._ord WHERE dining_option_name IS NOT NULL GROUP BY 1) d`],
  ["tax_jurisdiction", `CREATE TABLE output.tax_jurisdiction AS SELECT DISTINCT 'toast'::text AS source_system, tax_name, 'TX'::text AS jurisdiction, 'ASSUMED'::text AS status
      FROM sem.sem_order_items WHERE row_type='tax' AND tax_name IS NOT NULL`],

  // ---------------------------------------------------------------- dimensions
  ["dim_date", `CREATE TABLE output.dim_date AS SELECT d::date AS business_date, to_char(d,'YYYYMMDD')::bigint AS date_int,
      upper(to_char(d,'DY')) AS day_of_week_code, trim(to_char(d,'Day')) AS day_of_week_name, extract(isodow FROM d)::bigint AS day_of_week_number,
      date_trunc('week', d)::date AS week_start_date, date_trunc('month', d)::date AS month_start_date, extract(quarter FROM d)::bigint AS quarter,
      extract(year FROM d)::bigint AS year, (d - interval '364 days')::date AS same_weekday_last_year
      FROM generate_series('2022-01-01'::date, '2028-12-31'::date, interval '1 day') d`],
  ["dim_hour", `CREATE TABLE output.dim_hour AS SELECT h::bigint AS order_hour, 'H'||lpad(h::text,2,'0') AS hour_code,
      CASE WHEN h=0 THEN '12 AM' WHEN h<12 THEN h||' AM' WHEN h=12 THEN '12 PM' ELSE (h-12)||' PM' END AS hour_label FROM generate_series(0,23) h`],
  ["dim_location", `CREATE TABLE output.dim_location AS SELECT ${K("a.tenant_id", "a.store_location_id")} AS location_key, a.tenant_id, a.store_location_id, a.store_name,
      o.tenant_location_id, o.organisation_id, o.store_timezone, a.state_code, a.tax_jurisdiction, a.currency_code, a.service_mode, a.service_mode_label, true AS is_active
      FROM output.location_attributes a JOIN (SELECT DISTINCT tenant_id, store_location_id, tenant_location_id, organisation_id, store_timezone FROM sem.sem_order_header) o USING (tenant_id, store_location_id)`],
  ["dim_daypart", `CREATE TABLE output.dim_daypart AS SELECT ${K("tenant_id", "code")} AS daypart_key, tenant_id, code AS service_window_code, name AS service_window_name FROM (
      SELECT DISTINCT tenant_id, ${NM("service_window_name")} AS code, coalesce(nullif(service_window_name,''),'No Service') AS name FROM output._ord) x`],
  ["dim_channel", `CREATE TABLE output.dim_channel AS SELECT ${K("o.tenant_id", "o.nm")} AS channel_key, o.tenant_id, o.nm AS dining_option_code, o.nm AS dining_option_name,
      o.beh AS dining_option_behavior, initcap(replace(lower(o.beh),'_',' ')) AS dining_option_behavior_label,
      coalesce(x.fulfillment_mode,'Unknown') AS fulfillment_mode, coalesce(x.sales_channel,'UNMAPPED') AS sales_channel, x.partner_brand, coalesce(x.status,'UNMAPPED') AS crosswalk_status
      FROM (SELECT tenant_id, ${NM("dining_option_name")} AS nm, max(dining_option_behavior) beh FROM output._ord GROUP BY 1,2) o
      LEFT JOIN output.channel_crosswalk x ON x.source_value=o.nm`],
  ["dim_order_source", `CREATE TABLE output.dim_order_source AS SELECT ${K("tenant_id", "code")} AS order_source_key, tenant_id, code AS order_source_code, code AS order_source FROM (
      SELECT DISTINCT tenant_id, ${NM("order_source")} AS code FROM output._ord) x`],
  ["dim_revenue_center", `CREATE TABLE output.dim_revenue_center AS SELECT ${K("tenant_id", "code")} AS revenue_center_key, tenant_id, code AS revenue_center_code, coalesce(nullif(rc,''),'No Revenue Center') AS revenue_center_name FROM (
      SELECT DISTINCT tenant_id, ${NM("revenue_center_name")} AS code, revenue_center_name AS rc FROM output._ord) x`],
  ["dim_sales_category", `CREATE TABLE output.dim_sales_category AS SELECT ${K("tenant_id", "code")} AS sales_category_key, tenant_id, code AS sales_category_code, code AS sales_category_name, is_reportable FROM (
      SELECT tenant_id, ${SC("i")} AS code, bool_and(coalesce(drv_is_reportable_sales_category,true)) AS is_reportable FROM sem.sem_order_items i WHERE row_type='item' GROUP BY 1,2) x`],
  ["dim_menu_item", `CREATE TABLE output.dim_menu_item AS SELECT ${K("tenant_id", "code")} AS menu_item_key, tenant_id, code AS menu_item_code, max(menu_item_name) AS menu_item_name, max(item_name) AS item_name,
      max(menu_group_name) AS menu_group_code, max(menu_group_name) AS menu_group_name, max(menu_name) AS menu_code, max(menu_name) AS menu_name,
      max(item_type) AS item_type, initcap(replace(lower(max(item_type)),'_',' ')) AS item_type_label, coalesce(bool_or(drv_is_open_item=1),false) AS is_open_item
      FROM (SELECT i.*, ${MI("i")} AS code FROM sem.sem_order_items i WHERE row_type='item') x GROUP BY tenant_id, code`],
  ["dim_modifier", `CREATE TABLE output.dim_modifier AS SELECT ${K("tenant_id", "code")} AS modifier_key, tenant_id, code AS modifier_code, max(${NM("modifier_name")}) AS modifier_name,
      max(modifier_group_name) AS modifier_group_code, max(modifier_group_name) AS modifier_group_name, bool_and(modifier_group_name IS NULL) AS is_special_request
      FROM (SELECT i.*, ${MD("i")} AS code FROM sem.sem_order_items i WHERE row_type='modifier') x GROUP BY tenant_id, code`],
  ["dim_discount", `CREATE TABLE output.dim_discount AS SELECT ${K("tenant_id", "code")} AS discount_key, tenant_id, code AS discount_code, discount_name, discount_type, scope AS discount_scope,
      CASE scope WHEN 'CHECK' THEN 'Check-level' ELSE 'Item-level' END AS discount_scope_label, lv AS loyalty_vendor_code, lv AS loyalty_vendor FROM (
      SELECT DISTINCT tenant_id, discount_name, discount_type, CASE WHEN item_id IS NULL THEN 'CHECK' ELSE 'ITEM' END AS scope, discount_loyalty_vendor AS lv,
        coalesce(discount_name,'')||'|'||coalesce(discount_type,'')||'|'||(CASE WHEN item_id IS NULL THEN 'CHECK' ELSE 'ITEM' END)||'|'||coalesce(discount_loyalty_vendor,'') AS code
      FROM sem.sem_order_items WHERE row_type='discount') x`],
  ["dim_service_charge", `CREATE TABLE output.dim_service_charge AS SELECT ${K("tenant_id", "code")} AS service_charge_key, tenant_id, code AS service_charge_code,
      nm AS service_charge_name, ty AS service_charge_type, g AS is_gratuity_charge, CASE WHEN g THEN 'Y' ELSE 'N' END AS is_gratuity_code,
      t AS is_taxable_charge, CASE WHEN t THEN 'Y' ELSE 'N' END AS is_taxable_code FROM (
      SELECT DISTINCT tenant_id, config_service_charge_service_charge_name AS nm, service_charge_type AS ty, coalesce(is_gratuity_charge,false) AS g, coalesce(is_taxable_charge,false) AS t,
        coalesce(config_service_charge_service_charge_name,'')||'|'||coalesce(service_charge_type,'')||'|'||coalesce(is_gratuity_charge,false)::text||'|'||coalesce(is_taxable_charge,false)::text AS code
      FROM sem.sem_order_header WHERE source_array_index IS NOT NULL) x`],
  ["dim_tax_authority", `CREATE TABLE output.dim_tax_authority AS SELECT ${K("tenant_id", "code")} AS tax_key, tenant_id,
      CASE WHEN rem THEN 'MARKETPLACE_FACILITATOR' WHEN tax_name ~* 'facilitator' THEN 'MARKETPLACE_FACILITATOR' ELSE 'SALES_TAX' END AS tax_kind, tax_name, CASE WHEN tax_name ~* 'facilitator' THEN 'Marketplace facilitator tax - ' || (CASE WHEN rem THEN 'Remitted by marketplace' ELSE 'Remitted by restaurant' END) ELSE tax_name END AS tax_display_name,
      tax_rate, coalesce(tax_rate::text,'') AS tax_rate_code, CASE WHEN tax_rate IS NULL THEN 'n/a' ELSE round(tax_rate*100,2)||'%' END AS tax_rate_label,
      rem AS is_tax_marketplace_remitted, CASE WHEN rem THEN 'Y' ELSE 'N' END AS remitted_code, CASE WHEN rem THEN 'Marketplace' ELSE 'Restaurant' END AS remitted_by_label,
      j.jurisdiction FROM (
      SELECT DISTINCT tenant_id, tax_name, tax_rate, coalesce(is_tax_marketplace_remitted,false) AS rem, coalesce(tax_name,'')||'|'||coalesce(tax_rate::text,'') AS code
      FROM sem.sem_order_items WHERE row_type='tax') x LEFT JOIN output.tax_jurisdiction j USING (tax_name)`],
  ["dim_tender", `CREATE TABLE output.dim_tender AS SELECT ${K("tenant_id", "code")} AS tender_key, tenant_id, payment_type AS payment_type_code, drv_payment_type_group AS payment_type,
      coalesce(drv_payment_sub_type,'') AS payment_sub_type_code, drv_payment_sub_type AS payment_sub_type_label, coalesce(card_type,'') AS card_type_code, card_type, payment_status FROM (
      SELECT DISTINCT tenant_id, payment_type, drv_payment_type_group, drv_payment_sub_type, card_type, payment_status,
        coalesce(payment_type,'')||'|'||coalesce(drv_payment_sub_type,'')||'|'||coalesce(card_type,'')||'|'||coalesce(payment_status,'') AS code FROM sem.sem_order_payments) x`],
  ["dim_employee", `CREATE TABLE output.dim_employee AS SELECT DISTINCT ${K("tenant_id", "employee_id")} AS employee_key, tenant_id, employee_id AS employee_code, employee_name FROM sem.sem_labor`],
  ["dim_job", `CREATE TABLE output.dim_job AS SELECT ${K("tenant_id", "job_id")} AS job_key, tenant_id, job_id AS job_id_code, max(job_title) AS job_title, max(nullif(job_code,'')) AS job_code
      FROM sem.sem_labor GROUP BY tenant_id, job_id`],
  ["dim_exception_type", `CREATE TABLE output.dim_exception_type AS SELECT ${K("tenant_id", "code")} AS exception_key, tenant_id, exception_type, deferred_type, void_reason_code, void_reason_name FROM (
      SELECT DISTINCT tenant_id, 'VOID' AS exception_type, NULL::text AS deferred_type, ${NM("void_reason_name")} AS void_reason_code, void_reason_name, 'VOID|'||${NM("void_reason_name")} AS code
        FROM sem.sem_order_items WHERE row_type='item' AND drv_sales_status='VOIDED'
      UNION SELECT DISTINCT tenant_id, 'WASTE', NULL, NULL, NULL, 'WASTE' FROM sem.sem_order_items WHERE row_type='item'
      UNION SELECT DISTINCT tenant_id, 'DEFERRED', 'DEFERRED', NULL, NULL, 'DEFERRED' FROM sem.sem_order_items WHERE row_type='item'
      UNION SELECT DISTINCT tenant_id, 'UNPAID', NULL, NULL, NULL, 'UNPAID' FROM sem.sem_order_items WHERE row_type='item') x`],

  // ---------------------------------------------------------------- daily aggregates
  ["agg_order_daily", `CREATE TABLE output.agg_order_daily AS
    WITH items AS (SELECT store_location_id, order_id, sum(drv_countable_quantity) q FROM sem.sem_order_items WHERE row_type='item' GROUP BY 1,2),
    chg AS (SELECT store_location_id, order_id, sum(CASE WHEN is_gratuity_charge THEN drv_live_charge_amount ELSE 0 END) grat FROM sem.sem_order_header WHERE source_array_index IS NOT NULL GROUP BY 1,2),
    sale AS (SELECT o.tenant_id, o.store_location_id, o.bd AS business_date, o.drv_hour_order_opened_at::bigint AS order_hour,
        ${K("o.tenant_id", "o.dining_option_name")} AS channel_key, ${K("o.tenant_id", "o.revenue_center_name")} AS revenue_center_key,
        ${K("o.tenant_id", "o.service_window_name")} AS daypart_key, ${K("o.tenant_id", "o.order_source")} AS order_source_key,
        count(*) FILTER (WHERE o.drv_order_counted=1) AS order_count, coalesce(sum(o.guest_count) FILTER (WHERE o.drv_order_counted=1),0)::bigint AS guest_count,
        sum(o.drv_gross_sales) AS gross_sales, sum(o.drv_discount_amount_total) AS discount_amount, 0::numeric AS refund_amount,
        sum(o.drv_gross_sales - o.drv_discount_amount_total) AS net_sales, sum(o.drv_tax_amount_total) AS tax_amount, 0::numeric AS tax_refund_amount,
        sum(o.drv_service_charge_total) AS service_charge_amount, coalesce(sum(c.grat),0) AS gratuity_amount, coalesce(sum(i.q),0) AS item_qty,
        coalesce(sum(o.order_duration_seconds) FILTER (WHERE o.drv_order_counted=1 AND o.order_duration_seconds>0),0)::bigint AS turn_time_seconds,
        count(*) FILTER (WHERE o.drv_order_counted=1 AND o.order_duration_seconds>0) AS turn_time_orders,
        coalesce(sum(o.drv_has_voided_item) FILTER (WHERE o.is_order_voided IS NOT TRUE),0)::bigint AS voided_item_orders
      FROM output._ord o LEFT JOIN items i USING (store_location_id, order_id) LEFT JOIN chg c USING (store_location_id, order_id)
      GROUP BY 1,2,3,4,5,6,7,8),
    ref AS (SELECT p.tenant_id, p.store_location_id, ${D("p.payment_refund_business_date")} AS business_date, o.drv_hour_order_opened_at::bigint AS order_hour,
        ${K("p.tenant_id", "o.dining_option_name")} AS channel_key, ${K("p.tenant_id", "o.revenue_center_name")} AS revenue_center_key,
        ${K("p.tenant_id", "o.service_window_name")} AS daypart_key, ${K("p.tenant_id", "o.order_source")} AS order_source_key,
        0::bigint AS order_count, 0::bigint AS guest_count, 0::numeric AS gross_sales, 0::numeric AS discount_amount, sum(p.drv_refund_net_of_tax) AS refund_amount,
        -sum(p.drv_refund_net_of_tax) AS net_sales, 0::numeric AS tax_amount, sum(p.drv_refund_tax_amount) AS tax_refund_amount, 0::numeric AS service_charge_amount, 0::numeric AS gratuity_amount,
        0::numeric AS item_qty, 0::bigint AS turn_time_seconds, 0::bigint AS turn_time_orders, 0::bigint AS voided_item_orders
      FROM sem.sem_order_payments p JOIN output._ord o ON o.store_location_id=p.store_location_id AND o.order_id=p.order_id
      WHERE p.payment_refund_business_date IS NOT NULL GROUP BY 1,2,3,4,5,6,7,8)
    SELECT tenant_id, store_location_id, business_date, order_hour, channel_key, revenue_center_key, daypart_key, order_source_key,
      sum(order_count)::bigint order_count, sum(guest_count)::bigint guest_count, sum(gross_sales) gross_sales, sum(discount_amount) discount_amount, sum(refund_amount) refund_amount,
      sum(net_sales) net_sales, sum(tax_amount) tax_amount, sum(tax_refund_amount) tax_refund_amount, sum(service_charge_amount) service_charge_amount, sum(gratuity_amount) gratuity_amount,
      sum(item_qty) item_qty, sum(turn_time_seconds)::bigint turn_time_seconds, sum(turn_time_orders)::bigint turn_time_orders, sum(voided_item_orders)::bigint voided_item_orders,
      ${RUN} AS run_id, ${ASOF} AS as_of_ts
    FROM (SELECT * FROM sale UNION ALL SELECT * FROM ref) u GROUP BY 1,2,3,4,5,6,7,8`],

  ["agg_item_daily", `CREATE TABLE output.agg_item_daily AS
    SELECT i.tenant_id, i.store_location_id, ${D("i.order_business_date")} AS business_date, o.drv_hour_order_opened_at::bigint AS order_hour,
      ${K("i.tenant_id", MI("i"))} AS menu_item_key, ${K("i.tenant_id", SC("i"))} AS sales_category_key,
      ${K("i.tenant_id", "i.revenue_center_name")} AS revenue_center_key, ${K("i.tenant_id", "i.dining_option_name")} AS channel_key,
      ${K("i.tenant_id", "i.service_window_name")} AS daypart_key, i.drv_sales_status AS sales_status,
      sum(i.drv_countable_quantity) AS qty_sold, sum(i.drv_gross_sales) AS gross_amount, sum(i.drv_discount_incl_check_share) AS discount_amount, 0::numeric AS refund_amount,
      sum(i.drv_gross_sales - i.drv_discount_incl_check_share) AS net_amount, sum(i.drv_countable_tax_amount) AS tax_amount,
      coalesce(sum(i.item_price_before_discount) FILTER (WHERE i.drv_sales_status='VOIDED'),0) AS voided_gross_amount,
      coalesce(sum(i.item_quantity) FILTER (WHERE i.drv_sales_status='VOIDED'),0) AS voided_qty, sum(i.drv_deferred_amount) AS deferred_amount,
      coalesce(sum(i.item_quantity) FILTER (WHERE i.drv_sales_status='WASTE'),0) AS waste_qty,
      coalesce(sum(i.item_price_before_discount) FILTER (WHERE i.drv_sales_status='WASTE'),0) AS waste_amount, ${RUN} AS run_id, ${ASOF} AS as_of_ts
    FROM sem.sem_order_items i JOIN output._ord o ON o.store_location_id=i.store_location_id AND o.order_id=i.order_id
    WHERE i.row_type='item' GROUP BY 1,2,3,4,5,6,7,8,9,10`],

  ["agg_modifier_daily", `CREATE TABLE output.agg_modifier_daily AS
    SELECT i.tenant_id, i.store_location_id, ${D("i.order_business_date")} AS business_date, ${K("i.tenant_id", MD("i"))} AS modifier_key, i.drv_sales_status AS sales_status,
      coalesce(sum(i.modifier_quantity) FILTER (WHERE i.drv_sales_status='SOLD'),0) AS qty_sold,
      coalesce(sum(i.modifier_price_before_discount) FILTER (WHERE i.drv_sales_status='SOLD'),0) AS gross_amount, 0::numeric AS discount_amount, 0::numeric AS refund_amount,
      coalesce(sum(i.modifier_price_before_discount) FILTER (WHERE i.drv_sales_status='SOLD'),0) AS net_amount, 0::numeric AS tax_amount,
      coalesce(sum(i.modifier_price_before_discount) FILTER (WHERE i.drv_sales_status='VOIDED'),0) AS voided_gross_amount,
      coalesce(sum(i.modifier_quantity) FILTER (WHERE i.drv_sales_status='VOIDED'),0) AS voided_qty,
      coalesce(sum(i.modifier_price_before_discount) FILTER (WHERE i.drv_sales_status='DEFERRED'),0) AS deferred_amount,
      coalesce(sum(i.modifier_quantity) FILTER (WHERE i.drv_sales_status='WASTE'),0) AS waste_qty,
      coalesce(sum(i.modifier_price_before_discount) FILTER (WHERE i.drv_sales_status='WASTE'),0) AS waste_amount, ${RUN} AS run_id, ${ASOF} AS as_of_ts
    FROM sem.sem_order_items i WHERE i.row_type='modifier' GROUP BY 1,2,3,4,5`],

  ["agg_payment_daily", `CREATE TABLE output.agg_payment_daily AS
    WITH b AS (SELECT p.*,
        coalesce(p.payment_type,'')||'|'||coalesce(p.drv_payment_sub_type,'')||'|'||coalesce(p.card_type,'')||'|'||coalesce(p.payment_status,'') AS tcode
      FROM sem.sem_order_payments p),
    u AS (
      SELECT tenant_id, store_location_id, ${D("paid_business_date")} AS business_date, 'PAID' AS row_kind, tcode, dining_option_name, revenue_center_name,
        sum(drv_payment_count) AS payment_count, sum(payment_amount) FILTER (WHERE drv_payment_count=1) AS amount, sum(drv_tips) AS tips, sum(drv_gratuity_amount) AS gratuity,
        sum(drv_payment_tax_amount) AS tax_amount, 0::numeric AS refunds, 0::numeric AS tip_refunds, sum(payment_processing_fee_amount) FILTER (WHERE drv_payment_count=1) AS processing_fees,
        count(*) AS payment_rows, coalesce(sum(payment_amount + coalesce(drv_tips,0)) FILTER (WHERE drv_payment_count=1 AND order_business_date IS DISTINCT FROM paid_business_date),0) AS paid_in_amount, 0::numeric AS tips_by_order_date
      FROM b GROUP BY 1,2,3,4,5,6,7
      UNION ALL
      SELECT tenant_id, store_location_id, ${D("payment_refund_business_date")}, 'REFUND', tcode, dining_option_name, revenue_center_name,
        0, 0, 0, 0, 0, sum(drv_refund_net), sum(drv_tip_refund), 0, count(*), 0, 0 FROM b WHERE payment_refund_business_date IS NOT NULL GROUP BY 1,2,3,4,5,6,7
      UNION ALL
      SELECT tenant_id, store_location_id, ${D("order_business_date")}, 'ORDER_TIPS', tcode, dining_option_name, revenue_center_name,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sum(drv_tips) FROM b GROUP BY 1,2,3,4,5,6,7
      UNION ALL
      SELECT tenant_id, store_location_id, ${D("order_business_date")}, 'ORDER_DATE', tcode, dining_option_name, revenue_center_name,
        sum(drv_payment_count), coalesce(sum(payment_amount) FILTER (WHERE drv_payment_count=1),0), 0, 0, 0, 0, 0, 0, 0, 0, 0 FROM b GROUP BY 1,2,3,4,5,6,7)
    SELECT tenant_id, store_location_id, business_date, row_kind, ${K("tenant_id", "tcode")} AS tender_key, ${K("tenant_id", "dining_option_name")} AS channel_key,
      ${K("tenant_id", "revenue_center_name")} AS revenue_center_key, sum(payment_count)::bigint AS payment_count, coalesce(sum(amount),0) AS amount, sum(tips) AS tips, sum(gratuity) AS gratuity,
      sum(tax_amount) AS tax_amount, sum(refunds) AS refunds, sum(tip_refunds) AS tip_refunds, coalesce(sum(processing_fees),0) AS processing_fees, sum(payment_rows)::bigint AS payment_rows,
      sum(paid_in_amount) AS paid_in_amount, sum(tips_by_order_date) AS tips_by_order_date, ${RUN} AS run_id, ${ASOF} AS as_of_ts
    FROM u GROUP BY 1,2,3,4,5,6,7`],

  ["agg_charge_daily", `CREATE TABLE output.agg_charge_daily AS
    SELECT tenant_id, store_location_id, ${D("order_business_date")} AS business_date,
      ${K("tenant_id", "coalesce(config_service_charge_service_charge_name,'')||'|'||coalesce(service_charge_type,'')||'|'||coalesce(is_gratuity_charge,false)::text||'|'||coalesce(is_taxable_charge,false)::text")} AS service_charge_key,
      count(*)::bigint AS charge_count, sum(drv_live_charge_amount) AS charge_gross, coalesce(sum(service_charge_refund_amount),0) AS charge_refund_amount,
      sum(drv_live_charge_amount) - coalesce(sum(service_charge_refund_amount),0) AS charge_amount, sum(drv_charge_tax_amount) AS charge_tax_amount, ${RUN} AS run_id, ${ASOF} AS as_of_ts
    FROM sem.sem_order_header WHERE source_array_index IS NOT NULL GROUP BY 1,2,3,4`],

  ["agg_discount_daily", `CREATE TABLE output.agg_discount_daily AS
    SELECT tenant_id, store_location_id, ${D("order_business_date")} AS business_date,
      ${K("tenant_id", "coalesce(discount_name,'')||'|'||coalesce(discount_type,'')||'|'||(CASE WHEN item_id IS NULL THEN 'CHECK' ELSE 'ITEM' END)||'|'||coalesce(discount_loyalty_vendor,'')")} AS discount_key,
      count(*)::bigint AS application_count, sum(drv_discount_order_flag)::bigint AS order_count, sum(drv_discount) AS discount_amount, ${RUN} AS run_id, ${ASOF} AS as_of_ts
    FROM sem.sem_order_items WHERE row_type='discount' AND drv_is_live_discount=1 GROUP BY 1,2,3,4`],

  ["agg_tax_daily", `CREATE TABLE output.agg_tax_daily AS
    SELECT tenant_id, store_location_id, ${D("order_business_date")} AS business_date, ${K("tenant_id", "coalesce(tax_name,'')||'|'||coalesce(tax_rate::text,'')")} AS tax_key,
      sum(drv_tax_jurisdiction_amount) AS tax_amount, coalesce(sum(drv_tax_refund_amount),0) AS tax_refund_amount,
      sum(drv_tax_jurisdiction_amount) - coalesce(sum(drv_tax_refund_amount),0) AS net_tax_amount, sum(drv_taxable_amount) AS taxable_amount,
      coalesce(sum(drv_taxable_amount) FILTER (WHERE is_tax_marketplace_remitted IS TRUE),0) AS facilitator_base, ${RUN} AS run_id, ${ASOF} AS as_of_ts
    FROM sem.sem_order_items WHERE row_type='tax' GROUP BY 1,2,3,4`],

  ["agg_exception_daily", `CREATE TABLE output.agg_exception_daily AS
    SELECT tenant_id, store_location_id, business_date, exception_key, sum(amount) AS amount, count(DISTINCT order_id)::bigint AS order_count, sum(item_qty) AS item_qty, ${RUN} AS run_id, ${ASOF} AS as_of_ts FROM (
      SELECT i.tenant_id, i.store_location_id, ${D("i.order_business_date")} AS business_date, i.order_id,
        ${K("i.tenant_id", "'VOID|'||" + NM("i.void_reason_name"))} AS exception_key, i.item_price_before_discount AS amount, i.item_quantity AS item_qty
        FROM sem.sem_order_items i WHERE i.row_type='item' AND i.drv_sales_status='VOIDED'
      UNION ALL SELECT i.tenant_id, i.store_location_id, ${D("i.order_business_date")}, i.order_id, ${K("i.tenant_id", "'WASTE'")}, i.item_price_before_discount, i.item_quantity
        FROM sem.sem_order_items i WHERE i.row_type='item' AND i.drv_sales_status='WASTE'
      UNION ALL SELECT i.tenant_id, i.store_location_id, ${D("i.order_business_date")}, i.order_id, ${K("i.tenant_id", "'DEFERRED'")}, i.drv_deferred_amount, i.item_quantity
        FROM sem.sem_order_items i WHERE i.row_type='item' AND i.drv_sales_status='DEFERRED'
      UNION ALL SELECT o.tenant_id, o.store_location_id, o.bd, o.order_id, ${K("o.tenant_id", "'UNPAID'")}, o.drv_unpaid_amount, 0
        FROM output._ord o WHERE o.drv_unpaid_amount > 0) x GROUP BY 1,2,3,4`],

  ["agg_labor_daily", `CREATE TABLE output.agg_labor_daily AS
    SELECT tenant_id, store_location_id, ${D("labor_business_date")} AS business_date, ${K("tenant_id", "employee_id")} AS employee_key, ${K("tenant_id", "job_id")} AS job_key,
      count(*)::bigint AS shift_count, sum(employee_regular_hours) AS regular_hours, sum(labor_overtime_hours) AS overtime_hours, sum(drv_regular_pay::numeric) AS regular_pay,
      sum(employee_cash_tips_declared_amount) AS cash_tips_declared, sum(employee_non_cash_tips_amount) AS non_cash_tips,
      sum(coalesce(cash_gratuity_service_charge_amount,0) + coalesce(non_cash_gratuity_service_charge_amount,0)) AS gratuity, sum(employee_tips_withheld_amount) AS tips_withheld,
      sum(drv_total_sales::numeric) AS sales, ${RUN} AS run_id, ${ASOF} AS as_of_ts
    FROM sem.sem_labor GROUP BY 1,2,3,4,5`],
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await pool.query('DROP SCHEMA IF EXISTS "output" CASCADE; CREATE SCHEMA "output";');
  for (const [name, sql] of STEPS) {
    try { await pool.query(sql); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  const t = (await pool.query(`select table_name from information_schema.tables where table_schema='output' and table_name not like '\\_%' order by 1`)).rows;
  const out = [];
  for (const { table_name } of t) {
    const n = +(await pool.query(`select count(*) n from output.${table_name}`)).rows[0].n;
    const c = +(await pool.query(`select count(*) n from information_schema.columns where table_schema='output' and table_name=$1`, [table_name])).rows[0].n;
    out.push({ table: table_name, rows: n, columns: c });
  }
  console.table(out);
  await pool.end();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
