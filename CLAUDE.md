# Gyro Toast Pipeline - instructions for Claude

Nightly ETL for **Gyro Republic** (restaurant group on **Toast POS**) into **Neon Postgres**, built in layers. Every layer is validated against
Toast's own reports. Read this file first; it holds the rules the owner has given and the decisions made so far.

## Rules the owner has given (follow these)
1. **ASK BEFORE EVERY `git push`.** Every single time, even if a push was approved earlier. Commit locally if asked, then stop and ask. Never force-push.
2. **Never commit secrets.** `.env` is git-ignored and must stay so. Never print or paste the Toast client secret or `DATABASE_URL`. The Toast secret was pasted in chat once - the owner should rotate it.
3. **Build layer by layer, in order, from the schema file the owner supplies.** Do not guess a layer's schema; if the file is not in `schema/`, ask. Each layer is built **only from the layer before it**.
4. **Validate every layer against Toast.** A layer is not done until it ties out (see "Validation anchors"). Report mismatches honestly; do not paper over them.
5. **Scope for now: orders, menus, config, labor** (the rest of the Toast API is out of scope until asked). **One business day at a time**; backfill comes later with the same code.
6. **Tenant hierarchy** is ours, not Toast's: organisation *Gyro* -> 6 tenants -> 7 locations (below). Keep tenant/location on every row.
7. When unsure about a definition, **say what you assumed** and keep the assumption visible (sheet notes, status columns, this file).
8. Nightly run via **GitHub Actions** after 3-4 AM America/Chicago (owner set up the repo secrets). GitHub starts scheduled runs hours late, so the run is gated on the database ("is yesterday loaded?"), not on the clock - see Scheduling.
9. **Storage design = "Leaner"** (owner-approved, Nov 2026): order JSON in the API log kept **30 days** then pruned (orders stay in full in `raw.toast_orders`); `input` and `drv` keep only a rolling **45-day** window of orders/time entries; `raw`, `sem`, `output` keep full history. History starts **2025-12-29** (FY2026 P1).
10. **Fiscal calendar** = the owner's 4-4-5 calendar in `schema/fiscal_calendar.csv` (weeks Monday-Sunday). FY2026 ends 2026-12-27 - ask the owner for FY2027 rows before then.

## Organisation / tenants / locations
| Tenant | Location(s) |
|---|---|
| Gyro Corporate | Fondren, Richmond |
| Gyro Katy | Katy |
| Gyro Sugar Land | Sugar Land |
| Gyro Missouri City | Missouri City |
| Gyro Pearland | Pearland |
| Gyro Spring-Klein | Spring Klein (Toast name: "Spring - Klein") |

One Toast client / management group serves all 7. The location GUIDs are in `.env` as `TOAST_GUID_<LOCATION>`. `store_location_id` everywhere = the location name.

## Layers (Postgres schemas in Neon)
`Toast API -> raw -> input -> drv -> sem -> output -> reports`

| Layer | Schema | Built by | Schema file | What it is |
|---|---|---|---|---|
| SOR | `raw` | `src/pull.js` | - (plain JSON + run metadata) | untouched Toast JSON, per call/page, plus orders upserted on `modified_date` |
| Input | `input` | `src/build_input.js` | `schema/raw-input.yaml` | one `in_*` table per JSON array, walked by the YAML mapper |
| Derived | `drv` | `src/build_drv.js` | `schema/input-drv.yml` | `drv_*` = input + lineage + mapping joins + calculated `drv_` columns |
| Semantic | `sem` | `src/build_semantic.js` | `schema/semantic.yml` | 4 tables: `sem_order_header`, `sem_order_items`, `sem_order_payments`, `sem_labor` |
| Output | `output` | `src/build_output.js` | `schema/Output_Layer_Schema_output_marts_dev.pdf` | `dim_*`, `agg_*`, reference tables |
| Reports | files | `src/build_reports.js` | Toast exports as the target | Sales Summary + Product Mix xlsx, built ONLY from `output` |

**Not built yet:** `rpt_*` panel tables, `agg_waterfall_daily`, `panel_*` tables - they need the panel seed tables (`panel_measures`, `panel_members_fixed`, `panel_sections`), whose contents are not in the PDF. Ask the owner for them.
`raw` is append/upsert only (the audit trail). `input` is incremental: orders changed since the watermark (`input._build_state`, max `raw.toast_orders.fetched_at`) or missing are rebuilt, then anything older than 45 days is pruned. `drv` is rebuilt from `input` (so it covers the 45-day window). `sem` is updated in place: rows in the drv date window are deleted and re-inserted, older history is kept. `output` is rebuilt from `sem` (full history). `output.fiscal_calendar` + fiscal columns on `dim_date` come from the CSV.
Non-order API pages identical to the last stored copy are saved with `payload` NULL and `same_as_id` pointing to the copy; `src/prune_raw.js` nulls order JSON older than 30 days (`payload_pruned_at`).

## Raw layer rules (do not weaken)
- `raw.toast_orders`: one row per `order_guid`, upsert **only if the incoming `modified_date` is >= the stored one** (an old payload never overwrites a newer one).
- `raw.api_responses`: one row per call/page with status, duration, record count, page tokens and the JSON payload. `raw.pull_runs` and `raw.pipeline_runs` log every run.
- Attribute by **`businessDate`** (restaurant-local yyyymmdd), never UTC time. Toast's `startDate/endDate` filter on *modified* time, so the pull also uses a **padded modified-date window** to catch orders touched today with another business date (e.g. paid today for a future order = "paid in").
- `diningOptions` empty for a location halts that location (channel attribution would silently break). Rate limit 5 req/s per location, honour `Retry-After`. One location failing must not stop the others.

## Commands (run from this folder)
```
npm run nightly                 # whole pipeline for yesterday (store time), self-healing back-pad of 2 days
node src/nightly.js --date 20261103 [--backpad 0] [--skip-pull] [--deep]
npm run pull | input | drv | semantic | output | reconcile -- --date YYYYMMDD | reports
node src/compare_reports.js <toast_reports.json> <generated.json>   # diff against Toast's own xlsx
node src/unique_values.js                                            # UniqueValues_AllLocations.xlsx
node src/modifier_categories.js && node src/modifier_item_map.js    # modifier grouping sheets
node src/find_group.js "<modifier group name>"                       # where a modifier group sits
```
`nightly.js`: pull (self-healing) -> input -> drv -> semantic -> output -> **reconcile** (fails loud, exit 1) -> prune API log -> reports. Sunday runs also re-pull a 30-day modified window (late voids/catering cancellations; ~70 min). A DB advisory lock (727001, direct connection) prevents overlapping runs.
Backfill: `node src/nightly.js --from 20251229 [--date YYYYMMDD]` - per fiscal period: lean pulls (`pull.js --lean`: orders by business date, time entries, shifts, cash; no static config), build input for that period, drv, sem; then the normal window rebuild, output, reconcile every day. ~5-8 min of pulling per day.

## Config (`.env`, never committed; in CI these are GitHub repository secrets)
`DATABASE_URL`, `TOAST_API_HOSTNAME`, `TOAST_USER_ACCESS_TYPE`, `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET`, `TOAST_GUID_FONDREN|KATY|MISSOURI_CITY|PEARLAND|RICHMOND|SPRING_KLEIN|SUGAR_LAND`. Optional: `REPORT_DIR` (where reports are written).

## Scheduling (GitHub Actions)
`.github/workflows/nightly.yml` - three crons, 09:17, 11:17, 13:17 UTC (09:17 = 3:17 AM CST / 4:17 AM CDT; the others are fallbacks because GitHub often starts scheduled runs hours late or drops them). The first step, `src/should_run.js`, checks `raw.pipeline_runs`: if yesterday (Chicago) already succeeded, the run skips itself; otherwise it runs, however late. Scheduled workflows run from the default branch. Manual run: Actions -> "Run workflow" (optional date, optional deep re-pull). Reports are uploaded as an artifact.

## Validation anchors (business date 2026-11-03; must keep matching Toast)
- 484 non-voided orders (487 landed, 3 voided); guests 484; 481 live payments for the day.
- **Gross sales $11,459.67** = items $11,445.06 + service charges $14.61 (61 charges). **Net sales $10,168.58**. Tax $832.21. Tips $407.11. Discounts $1,291.09. Tips withheld $0.96 (Sugar Land, 4%).
- Toast "Sales category summary": all 30 categories match on items / net / gross. Paid-in total $271.67. Unpaid $43.26. Void amount $30.96.
- Reports: Sales Summary + Product Mix match Toast on 282 rows; 6 known differences (below). `src/reconcile.js` encodes the cross-layer checks.

## Definitions that differ from the supplied schema text (deliberate - they make numbers match Toast)
- **Gross sales includes service charges** (items pre-discount + service charges); the output layer keeps `service_charge_amount` separate.
- **Unpaid** = remaining balance on OPEN checks (check total minus payments), not the whole check.
- **Paid-in** = payment made on a business date different from its order's business date (either direction), not only "in advance".
- **Service-charge config join** uses `service_charge_id` (the config guid); the schema's `check_service_charge_id` never matches.
- **Item net by category** = gross - `drv_discount_incl_check_share` (the schema's `drv_net_sales` on an item excludes the check-level discount share; order-level net is correct).
- `INT` columns are stored as `numeric` (Toast sends decimals such as 1.6 for modifier length/width). Columns named `a/b/c` in the YAML use the first name. `JSON_TEXT` is stored as text.
- Toast menu / menu group on the reports come **per sold line**, so the output `menu_item_key` = menu | menu group | item; modifier key = modifier | group.
- `sem_labor` is one row per **time entry** (`shift_id` is empty for unscheduled clock-ins).
- Overtime pay (`drv_overtime_pay`, `drv_total_pay`) is intentionally not built (customer-specific, not confirmed).

## Assumptions to confirm with the owner
- `channel_crosswalk` (dining option -> channel/partner) is **inferred** from names (rows marked `INFERRED`).
- `location_attributes`: state/tax jurisdiction assumed `TX`, currency `USD`, service mode "Quick Service" (from Toast's report).
- Remaining report differences vs Toast: "Tips/Grat %" per card sub-type and grand total (denominator unknown); item tags (e.g. "Most ordered") are not in our layers.

## Modifier grouping (reference work)
98 modifier groups -> 12 types / 21 sub-types, rule-based on the group name (`src/modifier_rules.js`), checked against option contents and the item -> group -> option links. Names starting with "Extra" (incl. "Add: Extra ...") become **Extra Protein / Extra Sauce / Extra Pita**. Mapping covers every configured group whether or not it sold. Output: `SampleReports/UniqueValues_AllLocations.xlsx` (sheets: Modifier analysis, Modifier mapping, Modifier types, Modifier item map, Modifier mapping check).

## Toast API notes
Auth: `POST /authentication/v1/authentication/login` (`TOAST_MACHINE_CLIENT`). Every call except login/partners needs header `Toast-Restaurant-External-ID`. Working: orders (`ordersBulk`), `config/v2/*` (18 endpoints), `menus/v2`, labor (employees, jobs, shifts, timeEntries), cashmgmt, stock, partners. Not available to these credentials (404/not enabled): modifierGroups/modifierOptions as endpoints (data is inside menus), taxTables, labor breaks, noSalesReasons, kitchen prepStations, orderingschedule, packaging, availability, devices, analytics, giftcards, loyalty, tender.

## Working style
- Short, plain answers; state what was verified and what was not. Show numbers against Toast when reporting.
- Scripts are plain Node (CommonJS); `pg`, `exceljs`, `js-yaml`, `dotenv`. Keep new scripts in `src/`, temp files out of the repo.
- Re-running any stage must be safe (idempotent); never hand-edit data in `raw`.
