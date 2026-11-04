// Builds the Sales Summary and Product Mix reports (xlsx) ONLY from the output layer (schema "output").
//   node src/build_reports.js [--date YYYYMMDD] [--out <dir>]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { Pool } = require("pg");

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; };
const DATE = arg("date", "20261103");
const OUT = path.resolve(arg("out", path.join(__dirname, "../../SampleReports/generated")));
const day = `${DATE.slice(0, 4)}-${DATE.slice(4, 6)}-${DATE.slice(6, 8)}`;
const r2 = (x) => (x === null || x === undefined ? 0 : Math.round(Number(x) * 100) / 100);

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const Q = async (sql, params = []) => (await pool.query(sql, [day, ...params])).rows;
  const sheets = { ss: [], pm: [] }; // [name, header[], rows[][]]

  // ------------------------------------------------------------------ Sales Summary
  const ord = (await Q(`SELECT sum(order_count)::int orders, sum(guest_count)::int guests, sum(gross_sales) gross, sum(discount_amount) disc, sum(refund_amount) refunds, sum(net_sales) net,
      sum(tax_amount) tax, sum(service_charge_amount) svc, sum(gratuity_amount) grat, sum(turn_time_seconds) tsec, sum(turn_time_orders) tord
      FROM output.agg_order_daily WHERE business_date=$1`))[0];
  const pay = (await Q(`SELECT sum(payment_count)::int cnt, sum(amount) amt, sum(tips) tips, sum(gratuity) grat, sum(paid_in_amount) paid_in FROM output.agg_payment_daily WHERE business_date=$1 AND row_kind='PAID'`))[0];
  const payOrd = (await Q(`SELECT sum(payment_count)::int cnt, sum(amount) amt FROM output.agg_payment_daily WHERE business_date=$1 AND row_kind='ORDER_DATE'`))[0];
  const tipRef = (await Q(`SELECT sum(tip_refunds) tr FROM output.agg_payment_daily WHERE business_date=$1 AND row_kind='REFUND'`))[0];
  const lab = (await Q(`SELECT sum(tips_withheld) w FROM output.agg_labor_daily WHERE business_date=$1`))[0];
  const gross = r2(ord.gross) + r2(ord.svc), net = r2(ord.net) + r2(ord.svc);

  sheets.ss.push(["Revenue summary", ["Net sales", "Gratuity", "Tax amount", "Fundraising Contributions", "Fundraising Contribution Refunds", "Cash rounding", "Tips", "Deferred (gift cards)", "Deferred (house accounts)", "Deferred (other)", "deferredTaxAmount", "Paid in total", "Total"],
    [[r2(net), r2(pay.grat), r2(ord.tax), null, null, null, r2(pay.tips), null, null, null, 0, r2(pay.paid_in), r2(net + r2(pay.grat) + r2(ord.tax) + r2(pay.tips) + r2(pay.paid_in))]]]);
  sheets.ss.push(["Net sales summary", ["Gross sales", "Sales discounts", "Sales refunds", "Net sales"], [[r2(gross), -r2(ord.disc), r2(ord.refunds), r2(net)]]]);
  const tipsTot = r2(pay.tips) - r2(tipRef.tr);
  sheets.ss.push(["Tip summary", ["Tips collected", "Tips refunded", "Total tips", "Tips withheld", "Tips after withholding"],
    [[r2(pay.tips), r2(tipRef.tr), r2(tipsTot), -r2(lab.w), r2(tipsTot - r2(lab.w))]]]);
  const mode = (await Q(`SELECT max(service_mode_label) m FROM output.dim_location WHERE $1::text IS NOT NULL`))[0].m || "Quick Service";
  const smRow = [mode, r2(net), ord.guests, r2(net / ord.guests), payOrd.cnt, r2(payOrd.amt / payOrd.cnt), ord.orders, r2(net / ord.orders), r2(ord.tsec / 60 / ord.orders)];
  sheets.ss.push(["Service mode summary", ["Service mode", "Net sales", "Total guests", "Avg/Guest", "Total payments", "Avg/Payment", "Total orders", "Avg/Order", "Turn time (minutes)"],
    [smRow, ["Total", ...smRow.slice(1)]]]);

  // payments summary (by paid date, live payments)
  const pr = await Q(`SELECT t.payment_type, coalesce(t.payment_sub_type_label,'') sub, sum(a.payment_count)::int cnt, sum(a.amount) amt, sum(a.tips) tips, sum(a.gratuity) grat, sum(a.tax_amount) tax,
      sum(a.refunds) refunds, sum(a.tip_refunds) tref FROM output.agg_payment_daily a JOIN output.dim_tender t ON t.tender_key=a.tender_key AND t.tenant_id=a.tenant_id
      WHERE a.business_date=$1 AND a.row_kind='PAID' AND t.payment_status IN ('CAPTURED','AUTHORIZED') GROUP BY 1,2`);
  const od = await Q(`SELECT t.payment_type, coalesce(t.payment_sub_type_label,'') sub, sum(a.amount) amt FROM output.agg_payment_daily a JOIN output.dim_tender t ON t.tender_key=a.tender_key AND t.tenant_id=a.tenant_id
      WHERE a.business_date=$1 AND a.row_kind='ORDER_DATE' AND t.payment_status IN ('CAPTURED','AUTHORIZED') GROUP BY 1,2`);
  const odAmt = (t, sub) => od.filter((x) => x.payment_type === t && (sub === null || x.sub === sub)).reduce((s, x) => s + +x.amt, 0);
  const types = ["Cash", "Credit/debit", "Gift Card", "Other"], prow = [];
  const mk = (t, s, x) => { const den = t === "Total" ? od.reduce((a, y) => a + +y.amt, 0) : odAmt(t, s === "" ? null : s); return [t, s, x.cnt, r2(x.amt), r2(x.tips), r2(x.grat), r2(x.tax), r2(x.refunds), r2(x.tref), r2(x.tips), r2(x.amt) + r2(x.tips) + r2(x.grat), den > 0 ? Math.round(((r2(x.tips) + r2(x.grat)) / den) * 1000) / 10 : null]; };
  const sum = (rows) => rows.reduce((a, x) => ({ cnt: a.cnt + x.cnt, amt: a.amt + +x.amt, tips: a.tips + +x.tips, grat: a.grat + +x.grat, tax: a.tax + +x.tax, refunds: a.refunds + +x.refunds, tref: a.tref + +x.tref }), { cnt: 0, amt: 0, tips: 0, grat: 0, tax: 0, refunds: 0, tref: 0 });
  for (const t of types) {
    const rs = pr.filter((x) => x.payment_type === t).sort((a, b) => a.sub.localeCompare(b.sub));
    prow.push(mk(t, "", sum(rs)));
    for (const x of rs.filter((x) => x.sub !== "")) prow.push(mk(t, x.sub, x));
  }
  prow.push(mk("Total", "", sum(pr)));
  sheets.ss.push(["Payments summary", ["Payment type", "Payment sub type", "Count", "Amount", "Tips", "Grat", "Tax amount", "Refunds", "Tip refunds", "Legacy tips", "Total", "Tips/Grat %"], prow]);

  // sales category summary
  const cat = await Q(`SELECT s.sales_category_name n, sum(a.qty_sold) items, sum(a.net_amount) net, sum(a.discount_amount) disc, sum(a.refund_amount) ref, sum(a.gross_amount) gross, sum(a.tax_amount) tax
      FROM output.agg_item_daily a JOIN output.dim_sales_category s ON s.sales_category_key=a.sales_category_key AND s.tenant_id=a.tenant_id WHERE a.business_date=$1 GROUP BY 1`);
  const chg = (await Q(`SELECT sum(charge_count)::int n, sum(charge_amount) amt FROM output.agg_charge_daily WHERE business_date=$1`))[0];
  const crow = cat.filter((x) => +x.items > 0 || +x.gross !== 0).map((x) => [x.n, +x.items, r2(x.net), r2(x.disc), r2(x.ref), r2(x.gross), r2(x.tax)]);
  crow.push(["Non-Grat Svc Charges", chg.n, r2(chg.amt), 0, 0, r2(chg.amt), 0]);
  crow.sort((a, b) => a[0].localeCompare(b[0]));
  const tot = (rows) => ["Total", ...[1, 2, 3, 4, 5, 6].map((i) => r2(rows.reduce((s, r) => s + r[i], 0)))];
  sheets.ss.push(["Sales category summary", ["Sales category", "Items", "Net sales", "Discount amount", "Refund amount", "Gross sales", "Tax amount"], [...crow, tot(crow)]]);

  // revenue center summary
  const rcq = await Q(`WITH o AS (SELECT r.revenue_center_name n, sum(a.net_sales) net, sum(a.discount_amount) disc, sum(a.refund_amount) ref, sum(a.gross_sales) gross, sum(a.tax_amount) tax, sum(a.service_charge_amount) svc
        FROM output.agg_order_daily a JOIN output.dim_revenue_center r ON r.revenue_center_key=a.revenue_center_key AND r.tenant_id=a.tenant_id WHERE a.business_date=$1 GROUP BY 1),
      i AS (SELECT r.revenue_center_name n, sum(a.qty_sold) q FROM output.agg_item_daily a JOIN output.dim_revenue_center r ON r.revenue_center_key=a.revenue_center_key AND r.tenant_id=a.tenant_id WHERE a.business_date=$1 GROUP BY 1)
      SELECT o.*, coalesce(i.q,0) items FROM o LEFT JOIN i USING (n) ORDER BY n`);
  const rcr = rcq.map((x) => [x.n, +x.items, r2(+x.net + +x.svc), r2(x.disc), r2(x.ref), r2(+x.gross + +x.svc), r2(x.tax)]);
  sheets.ss.push(["Revenue center summary", ["Revenue center", "Items", "Net sales", "Discount amount", "Refund amount", "Gross sales", "Tax amount"], [...rcr, tot(rcr)]]);

  // dining options summary
  const dq = await Q(`SELECT c.dining_option_name n, sum(a.order_count)::int orders, sum(a.net_sales)+sum(a.service_charge_amount) net, sum(a.discount_amount) disc, sum(a.gross_sales)+sum(a.service_charge_amount) gross, sum(a.tax_amount) tax
      FROM output.agg_order_daily a JOIN output.dim_channel c ON c.channel_key=a.channel_key AND c.tenant_id=a.tenant_id WHERE a.business_date=$1 GROUP BY 1 ORDER BY 1`);
  const dr = dq.map((x) => [x.n, x.orders, r2(x.net), r2(x.disc), r2(x.gross), r2(x.tax)]);
  sheets.ss.push(["Dining options summary", ["Dining option", "Orders", "Net sales", "Discount amount", "Gross sales", "Tax amount"], [...dr, ["Total", ...[1, 2, 3, 4, 5].map((i) => r2(dr.reduce((s, r) => s + r[i], 0)))]]]);

  // tax summary
  const tq = await Q(`SELECT t.tax_display_name n, sum(a.tax_amount) tax, sum(a.taxable_amount) taxable FROM output.agg_tax_daily a JOIN output.dim_tax_authority t ON t.tax_key=a.tax_key AND t.tenant_id=a.tenant_id WHERE a.business_date=$1 GROUP BY 1`);
  const trows = tq.sort((a, b) => (/facilitator/i.test(a.n) ? 1 : 0) - (/facilitator/i.test(b.n) ? 1 : 0)).map((x) => [x.n, r2(x.tax), r2(x.taxable)]);
  trows.splice(trows.findIndex((r) => /facilitator/i.test(r[0])) < 0 ? trows.length : trows.findIndex((r) => /facilitator/i.test(r[0])), 0, ["Non Taxable", 0, 0]);
  sheets.ss.push(["Tax summary", ["Tax rate", "Tax amount", "Taxable amount"], trows]);

  // service charge summary
  const sq = await Q(`SELECT s.service_charge_name n, sum(a.charge_count)::int c, sum(a.charge_amount) amt FROM output.agg_charge_daily a JOIN output.dim_service_charge s ON s.service_charge_key=a.service_charge_key AND s.tenant_id=a.tenant_id WHERE a.business_date=$1 GROUP BY 1 ORDER BY 1`);
  const sr = sq.map((x) => [x.n || "UNKNOWN", x.c, r2(x.amt)]);
  sheets.ss.push(["Service charge summary", ["Service charge", "Count", "Amount"], [...sr, ["Total", sr.reduce((s, r) => s + r[1], 0), r2(sr.reduce((s, r) => s + r[2], 0))]]]);

  // discounts
  for (const [sheet, scope] of [["Menu Item Discounts", "ITEM"], ["Check Discounts", "CHECK"]]) {
    const dd = await Q(`SELECT d.discount_name n, sum(a.application_count)::int c, sum(a.order_count)::int o, sum(a.discount_amount) amt FROM output.agg_discount_daily a JOIN output.dim_discount d ON d.discount_key=a.discount_key AND d.tenant_id=a.tenant_id
        WHERE a.business_date=$1 AND d.discount_scope=$2 GROUP BY 1 ORDER BY lower(d.discount_name)`, [scope]);
    const rr = dd.map((x) => [x.n, x.c, x.o, r2(x.amt)]);
    sheets.ss.push([sheet, ["Discount", "Count", "Orders", "Amount"], [...rr, ["Total", rr.reduce((s, r) => s + r[1], 0), rr.reduce((s, r) => s + r[2], 0), r2(rr.reduce((s, r) => s + r[3], 0))]]]);
  }

  // daypart
  const dp = await Q(`SELECT d.service_window_name n, sum(a.order_count)::int orders, sum(a.net_sales)+sum(a.service_charge_amount) net, sum(a.discount_amount) disc, sum(a.refund_amount) ref, sum(a.gross_sales)+sum(a.service_charge_amount) gross, sum(a.tax_amount) tax
      FROM output.agg_order_daily a JOIN output.dim_daypart d ON d.daypart_key=a.daypart_key AND d.tenant_id=a.tenant_id WHERE a.business_date=$1 GROUP BY 1 ORDER BY 1`);
  const dpr = dp.map((x) => [x.n, x.orders, r2(x.net), r2(x.disc), r2(x.ref), r2(x.gross), r2(x.tax)]);
  sheets.ss.push(["Service Daypart summary", ["Service / day part", "Orders", "Net sales", "Discount amount", "Refund amount", "Gross sales", "Tax amount"], [...dpr, ["Total", ...[1, 2, 3, 4, 5, 6].map((i) => r2(dpr.reduce((s, r) => s + r[i], 0)))]]]);

  // deferred / unpaid / void / cash
  const ex = await Q(`SELECT e.exception_type t, sum(a.amount) amt, sum(a.order_count)::int ord, sum(a.item_qty) qty FROM output.agg_exception_daily a JOIN output.dim_exception_type e ON e.exception_key=a.exception_key AND e.tenant_id=a.tenant_id WHERE a.business_date=$1 GROUP BY 1`);
  const E = (t) => ex.find((x) => x.t === t) || { amt: 0, ord: 0, qty: 0 };
  sheets.ss.push(["Deferred summary", [], []]);
  sheets.ss.push(["Unpaid orders summary", ["Unpaid amount"], [[r2(E("UNPAID").amt)]]]);
  const itemGross = (await Q(`SELECT sum(gross_amount) g FROM output.agg_item_daily WHERE business_date=$1`))[0].g;
  sheets.ss.push(["Void summary", ["Void amount", "Void order count", "Void item count", "Void amount %"], [[r2(E("VOID").amt), E("VOID").ord, +E("VOID").qty, Math.round((r2(E("VOID").amt) / r2(itemGross)) * 1000) / 10]]]);
  sheets.ss.push(["Cash activity", [], []]);
  sheets.ss.push(["Cash summary", [], []]);

  // sales by day / day of week / time of day
  sheets.ss.push(["Sales by day", ["yyyyMMdd", "Net sales", "Total orders", "Total guests"], [[+DATE, r2(net), ord.orders, ord.guests]]]);
  const dow = (await Q(`SELECT left(d.day_of_week_name,3) n FROM output.dim_date d WHERE d.business_date=$1`))[0].n;
  sheets.ss.push(["Day of week (totals)", ["Day of week", "Net sales", "Total orders", "Total guests"], [[dow, r2(net), ord.orders, ord.guests]]]);
  const hq = await Q(`SELECT a.order_hour h, sum(a.net_sales)+sum(a.service_charge_amount) net, sum(a.order_count)::int o, sum(a.guest_count)::int g FROM output.agg_order_daily a WHERE a.business_date=$1 AND a.order_hour IS NOT NULL GROUP BY 1 ORDER BY 1`);
  sheets.ss.push(["Time of day (totals)", ["Hour of day", "Net sales", "Total orders", "Total guests"], hq.filter((x) => +x.o > 0 || r2(x.net) !== 0).map((x) => [+x.h, r2(x.net), x.o, x.g])]);

  // ------------------------------------------------------------------ Product Mix
  const PMH = ["Qty sold", "Avg. price", "Gross item amt", "Discount amt", "Refund amt", "Void amt", "Net item amt", "COGS", "Gross profit", "Gross margin (%)", "Tax amt", "Waste count", "Waste amt"];
  const pmRow = (k, x) => [...k, +x.qty, x.qty > 0 ? r2(x.gross / x.qty) : 0, r2(x.gross), r2(x.disc), r2(x.ref), r2(x.void), r2(x.net), null, null, null, r2(x.tax), +x.wq, r2(x.wa)];
  const itemAgg = (key) => Q(`SELECT ${key} k, sum(a.qty_sold) qty, sum(a.gross_amount) gross, sum(a.discount_amount) disc, sum(a.refund_amount) ref, sum(a.voided_gross_amount) void, sum(a.net_amount) net, sum(a.tax_amount) tax, sum(a.waste_qty) wq, sum(a.waste_amount) wa
      FROM output.agg_item_daily a JOIN output.dim_menu_item m ON m.menu_item_key=a.menu_item_key AND m.tenant_id=a.tenant_id WHERE a.business_date=$1 GROUP BY 1`);
  const tt = (await itemAgg("'t'"))[0];
  sheets.pm.push(["Summary", ["Qty sold", "Gross item amt", "Net item amt", "Tax amt", "Avg. price", "COGS", "Gross profit", "Gross margin (%)"], [[+tt.qty, r2(tt.gross), r2(tt.net), r2(tt.tax), r2(tt.gross / tt.qty), null, null, null]]]);
  const menus = await itemAgg("m.menu_name");
  sheets.pm.push(["Menus", ["Menu", ...PMH], [pmRow([null], tt), ...menus.sort((a, b) => +b.qty - +a.qty).map((x) => pmRow([x.k], x))]]);
  const groups = await itemAgg("m.menu_group_name");
  sheets.pm.push(["Menu groups", ["Menu group", "Subgroup", ...PMH], [pmRow([null, null], tt), ...groups.sort((a, b) => +b.qty - +a.qty).map((x) => pmRow([x.k, null], x))]]);
  const items = await itemAgg("m.menu_item_name");
  sheets.pm.push(["Items", ["Item", "Item tags", "Item COGS", ...PMH.slice(0, 2)].slice(0, 2).concat(["Qty sold", "Avg. price", "Item COGS", "Gross item amt", "Discount amt", "Refund amt", "Void amt", "Net item amt", "COGS", "Gross profit", "Gross margin (%)", "Tax amt", "Waste count", "Waste amt"]),
    [[null, null, +tt.qty, r2(tt.gross / tt.qty), null, r2(tt.gross), r2(tt.disc), r2(tt.ref), r2(tt.void), r2(tt.net), null, null, null, r2(tt.tax), +tt.wq, r2(tt.wa)],
      ...items.sort((a, b) => +b.qty - +a.qty).map((x) => [x.k, null, +x.qty, x.qty > 0 ? r2(x.gross / x.qty) : 0, null, r2(x.gross), r2(x.disc), r2(x.ref), r2(x.void), r2(x.net), null, null, null, r2(x.tax), +x.wq, r2(x.wa)])]]);
  sheets.pm.push(["Open items", [], []]);
  const MH = ["Qty sold", "Avg. price", "Gross item amt", "Discount amt", "Refund amt", "Void amt", "Net item amt", "Waste count", "Waste amt"];
  for (const [sheet, label, special] of [["Modifiers", "Modifier", false], ["Special requests", "Special request", true]]) {
    const mm = await Q(`SELECT m.modifier_name k, sum(a.qty_sold) qty, sum(a.gross_amount) gross, sum(a.discount_amount) disc, sum(a.refund_amount) ref, sum(a.voided_gross_amount) void, sum(a.net_amount) net, sum(a.waste_qty) wq, sum(a.waste_amount) wa
        FROM output.agg_modifier_daily a JOIN output.dim_modifier m ON m.modifier_key=a.modifier_key AND m.tenant_id=a.tenant_id WHERE a.business_date=$1 AND m.is_special_request=$2 GROUP BY 1`, [special]);
    const row = (k, x) => [null, k, null, +x.qty, x.qty > 0 ? r2(x.gross / x.qty) : 0, r2(x.gross), r2(x.disc), r2(x.ref), r2(x.void), r2(x.net), +x.wq, r2(x.wa)];
    const t0 = mm.reduce((a, x) => ({ qty: a.qty + +x.qty, gross: a.gross + +x.gross, disc: a.disc + +x.disc, ref: a.ref + +x.ref, void: a.void + +x.void, net: a.net + +x.net, wq: a.wq + +x.wq, wa: a.wa + +x.wa }), { qty: 0, gross: 0, disc: 0, ref: 0, void: 0, net: 0, wq: 0, wa: 0 });
    sheets.pm.push([sheet, ["Size modifier", label, "Item tags", ...MH], [row(null, t0), ...mm.sort((a, b) => +b.gross - +a.gross || +b.qty - +a.qty).map((x) => row(x.k, x))]]);
  }

  // ------------------------------------------------------------------ write xlsx
  fs.mkdirSync(OUT, { recursive: true });
  const written = {};
  for (const [k, title] of [["ss", "SalesSummary"], ["pm", "ProductMix"]]) {
    const wb = new ExcelJS.Workbook();
    for (const [name, header, rows] of sheets[k]) {
      const ws = wb.addWorksheet(name);
      if (header.length) { ws.addRow(header).font = { bold: true }; rows.forEach((r) => ws.addRow(r)); ws.columns.forEach((c) => (c.width = 18)); }
    }
    const f = path.join(OUT, `${title}_${day}_${day}.xlsx`);
    await wb.xlsx.writeFile(f); written[k] = f;
  }
  fs.writeFileSync(path.join(OUT, "generated.json"), JSON.stringify(sheets));
  console.log("written:", Object.values(written).join("\n         "));
  await pool.end();
}
main().catch((e) => { console.error("FAIL:", e.message, e.stack.split("\n")[1]); process.exit(1); });
