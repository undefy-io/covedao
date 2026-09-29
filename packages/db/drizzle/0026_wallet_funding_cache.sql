CREATE TABLE cove_wallet_funding (
  network text NOT NULL,
  wallet_script text NOT NULL,
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (network, wallet_script)
);
--> statement-breakpoint
CREATE INDEX cove_wallet_funding_observed_idx ON cove_wallet_funding (observed_at);
