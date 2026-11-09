CREATE SCHEMA IF NOT EXISTS raw;

CREATE TABLE IF NOT EXISTS raw.tenant_locations (
  org            text NOT NULL,
  tenant         text NOT NULL,
  location_name  text NOT NULL,
  location_guid  uuid PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS raw.pull_runs (
  run_id         uuid PRIMARY KEY,
  business_date  int  NOT NULL,
  window_start   timestamptz,
  window_end     timestamptz,
  locations      text[],
  status         text NOT NULL DEFAULT 'running',  -- running | success | partial | failed
  error          text,
  calls_total    int,
  calls_ok       int,
  calls_failed   int,
  orders_landed  int,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

CREATE TABLE IF NOT EXISTS raw.api_responses (
  id             bigserial PRIMARY KEY,
  run_id         uuid NOT NULL REFERENCES raw.pull_runs(run_id),
  tenant         text,
  location_name  text,
  location_guid  uuid,
  endpoint       text NOT NULL,
  request_params jsonb,
  page_no        int,
  page_token     text,
  next_page_token text,
  http_status    int,
  duration_ms    int,
  record_count   int,
  error          text,
  payload        jsonb,
  fetched_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_responses_run_idx ON raw.api_responses(run_id);
CREATE INDEX IF NOT EXISTS api_responses_ep_idx  ON raw.api_responses(endpoint, location_guid);

CREATE TABLE IF NOT EXISTS raw.toast_orders (
  order_guid     uuid PRIMARY KEY,
  tenant         text,
  location_name  text,
  location_guid  uuid,
  business_date  int,
  modified_date  timestamptz,
  payload        jsonb NOT NULL,
  pull_run_id    uuid NOT NULL REFERENCES raw.pull_runs(run_id),
  fetched_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS toast_orders_bd_idx ON raw.toast_orders(location_guid, business_date);

-- Leaner storage (2026-11): config/menu snapshots stored only when they change (same_as_id points at the stored copy);
-- order JSON in the API log is kept 30 days, then pruned (raw.toast_orders keeps the latest copy of every order forever).
ALTER TABLE raw.api_responses ADD COLUMN IF NOT EXISTS payload_md5 text;
ALTER TABLE raw.api_responses ADD COLUMN IF NOT EXISTS same_as_id bigint;
ALTER TABLE raw.api_responses ADD COLUMN IF NOT EXISTS payload_pruned_at timestamptz;
CREATE INDEX IF NOT EXISTS api_responses_snap_idx ON raw.api_responses(location_guid, endpoint, page_no, payload_md5) WHERE payload IS NOT NULL;
CREATE INDEX IF NOT EXISTS toast_orders_fetched_idx ON raw.toast_orders(fetched_at);
