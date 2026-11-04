require("dotenv").config({ quiet: true });
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOST = process.env.TOAST_API_HOSTNAME;
const MIN_INTERVAL_MS = 200; // 5 req/s per location
const PAGE_SIZE = 100;

// Tenant -> locations (logical grouping; Toast has no tenant concept)
const TENANTS = [
  ["Gyro Corporate", ["FONDREN", "RICHMOND"]],
  ["Gyro Katy", ["KATY"]],
  ["Gyro Sugar Land", ["SUGAR_LAND"]],
  ["Gyro Missouri City", ["MISSOURI_CITY"]],
  ["Gyro Pearland", ["PEARLAND"]],
  ["Gyro Spring-Klein", ["SPRING_KLEIN"]],
];
const LOCATIONS = TENANTS.flatMap(([tenant, keys]) =>
  keys.map((k) => ({
    tenant,
    name: k.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" "),
    guid: process.env["TOAST_GUID_" + k],
  }))
);

const cfg = (p) => ({ path: p, paging: "token" });
// Read-only endpoints. bd = businessDate yyyymmdd, iso(start/end) = window.
const ENDPOINTS = [
  { path: "/restaurants/v1/restaurants/{guid}" },
  ...[
    "diningOptions", "revenueCenters", "salesCategories", "alternatePaymentTypes",
    "restaurantServices", "serviceAreas", "tables", "discounts", "menuGroups",
    "menuItems", "menus", "menuOptionGroups", "preModifierGroups", "preModifiers",
    "priceGroups", "printers", "voidReasons", "payoutReasons", "cashDrawers",
    "breakTypes", "tipWithholding", "serviceCharges", "taxRates",
  ].map((n) => cfg("/config/v2/" + n)),
  { path: "/menus/v2/menus" },
  { path: "/menus/v2/metadata" },
  { path: "/labor/v1/employees" },
  { path: "/labor/v1/jobs" },
  { path: "/labor/v1/shifts", params: (c) => ({ startDate: c.startIso, endDate: c.endIso }) },
  { path: "/labor/v1/timeEntries", params: (c) => ({ businessDate: c.bd }) },
  { path: "/cashmgmt/v1/entries", params: (c) => ({ businessDate: c.bd }) },
  { path: "/cashmgmt/v1/deposits", params: (c) => ({ businessDate: c.bd }) },
  { path: "/stock/v1/inventory" },
];

// Not location-scoped: pulled once per run (tenant/location null)
const ORG_ENDPOINTS = [
  { path: "/partners/v1/restaurants" },
  { path: "/partners/v1/connectedRestaurants", params: () => ({ pageSize: 100 }) },
  { path: "/restaurants/v1/groups/5f96ff59-a662-4e4d-a083-ac8f4fe72346/restaurants" },
];
// Probed 2026-11-04, not available to these credentials (404 / service not enabled):
// modifierGroups, modifierOptions, taxTables, labor/breaks, noSalesReasons, kitchen/prepStations,
// orderingschedule/*, packaging/*, availability, analytics, devices (403-ish), giftcards, loyalty, tender, ccpartner

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (b) => (Array.isArray(b) ? b.length : null);

async function login() {
  const r = await fetch(HOST + "/authentication/v1/authentication/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: process.env.TOAST_CLIENT_ID,
      clientSecret: process.env.TOAST_CLIENT_SECRET,
      userAccessType: process.env.TOAST_USER_ACCESS_TYPE,
    }),
  });
  const j = await r.json();
  if (!j.token) throw new Error("Toast login failed: " + r.status);
  return j.token.accessToken;
}

function makeClient(token, guid) {
  let last = 0;
  return async function get(p, params) {
    const url = new URL(HOST + p);
    for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const wait = last + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          headers: { Authorization: "Bearer " + token, "Toast-Restaurant-External-ID": guid },
        });
        if (res.status === 429) {
          await sleep((Number(res.headers.get("retry-after")) || 2) * 1000);
          continue;
        }
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = { _raw_text: text.slice(0, 2000) }; }
        return {
          status: res.status, body, ms: Date.now() - t0,
          next: res.headers.get("toast-next-page-token"),
        };
      } catch (e) {
        if (attempt === 5) return { status: 0, body: null, ms: Date.now() - t0, error: String(e.message || e) };
        await sleep(500 * 2 ** attempt);
      }
    }
    return { status: 429, body: null, ms: 0, error: "rate limited after retries" };
  };
}

async function main() {
  const arg = (n) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : null; };
  const d = arg("date") || (() => { const t = new Date(Date.now() - 864e5); return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(t).replace(/-/g, ""); })();
  if (!/^\d{8}$/.test(d)) throw new Error("--date must be yyyymmdd");
  const bd = Number(d);
  const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  // padded modified/shift window: day-1 .. day+2 (UTC)
  const padDays = Number(arg("pad-days") || 1);
  const startIso = new Date(Date.parse(day + "T00:00:00Z") - padDays * 864e5).toISOString().replace("Z", "+0000");
  const endIso = new Date(Date.parse(day + "T00:00:00Z") + 2 * 864e5).toISOString().replace("Z", "+0000");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: LOCATIONS.length + 2 });
  await pool.query(fs.readFileSync(path.join(__dirname, "../sql/001_raw.sql"), "utf8"));
  for (const l of LOCATIONS)
    await pool.query(
      `INSERT INTO raw.tenant_locations(org,tenant,location_name,location_guid) VALUES ('Gyro',$1,$2,$3)
       ON CONFLICT (location_guid) DO UPDATE SET tenant=EXCLUDED.tenant, location_name=EXCLUDED.location_name`,
      [l.tenant, l.name, l.guid]
    );

  const runId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO raw.pull_runs(run_id,business_date,window_start,window_end,locations) VALUES ($1,$2,$3,$4,$5)`,
    [runId, bd, startIso.replace("+0000", "Z"), endIso.replace("+0000", "Z"), LOCATIONS.map((l) => l.name)]
  );
  console.log(`run ${runId} businessDate=${bd}`);

  const token = await login();
  const stats = { total: 0, ok: 0, failed: 0, orders: 0 };
  const failures = [];

  async function save(loc, ep, params, pageNo, pageToken, r) {
    const ok = r.status >= 200 && r.status < 300;
    stats.total++; ok ? stats.ok++ : stats.failed++;
    await pool.query(
      `INSERT INTO raw.api_responses(run_id,tenant,location_name,location_guid,endpoint,request_params,page_no,page_token,next_page_token,http_status,duration_ms,record_count,error,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [runId, loc.tenant, loc.name, loc.guid, ep, JSON.stringify(params || {}), pageNo, pageToken || null,
       r.next || null, r.status, r.ms, rows(r.body), r.error || (ok ? null : "HTTP " + r.status), JSON.stringify(r.body)]
    );
    return ok;
  }

  async function landOrders(loc, list) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const o of list) {
        try {
          await c.query("SAVEPOINT s");
          const res = await c.query(
            `INSERT INTO raw.toast_orders(order_guid,tenant,location_name,location_guid,business_date,modified_date,payload,pull_run_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
             ON CONFLICT (order_guid) DO UPDATE SET payload=EXCLUDED.payload, modified_date=EXCLUDED.modified_date,
               business_date=EXCLUDED.business_date, pull_run_id=EXCLUDED.pull_run_id, fetched_at=now()
             WHERE EXCLUDED.modified_date IS NULL OR raw.toast_orders.modified_date IS NULL
                OR EXCLUDED.modified_date >= raw.toast_orders.modified_date`,
            [o.guid, loc.tenant, loc.name, loc.guid, o.businessDate ?? null, o.modifiedDate ?? null, JSON.stringify(o), runId]
          );
          stats.orders += res.rowCount;
          await c.query("RELEASE SAVEPOINT s");
        } catch (e) {
          await c.query("ROLLBACK TO SAVEPOINT s");
          failures.push(`${loc.name}: order ${o.guid} not landed: ${e.message}`);
        }
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      failures.push(`${loc.name}: page not landed: ${e.message}`);
    } finally { c.release(); }
  }

  async function runLocation(loc) {
    const get = makeClient(token, loc.guid);
    const ctx = { bd, startIso, endIso };
    // Orders first-class: ordersBulk by businessDate, paged
    for (let page = 1; ; page++) {
      const params = { businessDate: bd, page, pageSize: PAGE_SIZE };
      const r = await get("/orders/v2/ordersBulk", params);
      const ok = await save(loc, "/orders/v2/ordersBulk", params, page, null, r);
      if (!ok) { failures.push(`${loc.name}: ordersBulk page ${page} -> ${r.status}`); break; }
      await landOrders(loc, r.body);
      if (!Array.isArray(r.body) || r.body.length < PAGE_SIZE) break;
    }
    // Padded modified-date window: orders touched in the window but with another business date
    // (e.g. paid today for a future order). Attributed later by payload.businessDate.
    for (let page = 1; ; page++) {
      const params = { startDate: startIso, endDate: endIso, page, pageSize: PAGE_SIZE };
      const r = await get("/orders/v2/ordersBulk", params);
      const ok = await save(loc, "/orders/v2/ordersBulk", params, page, null, r);
      if (!ok) { failures.push(`${loc.name}: ordersBulk(modified window) page ${page} -> ${r.status}`); break; }
      await landOrders(loc, r.body);
      if (!Array.isArray(r.body) || r.body.length < PAGE_SIZE) break;
    }
    for (const ep of ENDPOINTS) {
      const p = ep.path.replace("{guid}", loc.guid);
      let token_ = null;
      for (let page = 1; ; page++) {
        const params = { ...(ep.params ? ep.params(ctx) : {}), ...(ep.paging && token_ ? { pageToken: token_ } : {}) };
        const r = await get(p, params);
        const ok = await save(loc, p, params, page, token_, r);
        if (p.endsWith("/diningOptions") && ok && Array.isArray(r.body) && r.body.length === 0)
          throw new Error(`${loc.name}: diningOptions empty — halting this location`);
        if (!ok || !r.next) break;
        token_ = r.next;
      }
    }
  }

  {
    const get = makeClient(token, LOCATIONS[0].guid);
    for (const ep of ORG_ENDPOINTS) {
      const params = ep.params ? ep.params() : {};
      const r = await get(ep.path, params);
      await save({ tenant: null, name: null, guid: null }, ep.path, params, 1, null, r);
    }
  }
  await Promise.all(
    LOCATIONS.map((loc) => runLocation(loc).catch((e) => failures.push(`${loc.name}: ${e.message}`)))
  );

  const hardFail = failures.filter((f) => /halting|Toast login/.test(f)).length;
  const status = hardFail === LOCATIONS.length ? "failed" : hardFail || failures.length ? "partial" : "success";
  await pool.query(
    `UPDATE raw.pull_runs SET status=$2,error=$3,calls_total=$4,calls_ok=$5,calls_failed=$6,orders_landed=$7,finished_at=now() WHERE run_id=$1`,
    [runId, status, failures.length ? failures.slice(0, 50).join("\n") : null, stats.total, stats.ok, stats.failed, stats.orders]
  );
  console.log(`status=${status} calls=${stats.total} ok=${stats.ok} non2xx=${stats.failed} orders=${stats.orders}`);
  await pool.end();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
