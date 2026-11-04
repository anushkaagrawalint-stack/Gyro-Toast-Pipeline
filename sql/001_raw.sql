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
