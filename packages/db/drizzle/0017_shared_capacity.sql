CREATE TABLE IF NOT EXISTS cove_api_quotas (
  key text PRIMARY KEY,
  window_start bigint NOT NULL,
  count integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cove_api_quotas_window_idx ON cove_api_quotas (window_start);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cove_rpc_budgets (
  account text PRIMARY KEY,
  state jsonb NOT NULL DEFAULT '{"rate":3,"concurrency":6,"next":0,"lanes":{},"leases":[]}'::jsonb
);
--> statement-breakpoint
ALTER TABLE cove_v3_market_listings ADD COLUMN last_observed_at timestamptz NOT NULL DEFAULT '1970-01-01 00:00:00+00';
--> statement-breakpoint
CREATE INDEX cove_v3_listing_observation_idx ON cove_v3_market_listings (network, status, last_observed_at);
