CREATE TABLE IF NOT EXISTS "cove_v3_runtime" (
	"network" text PRIMARY KEY NOT NULL,
	"core_height" bigint DEFAULT 0 NOT NULL,
	"core_tip" text DEFAULT '' NOT NULL,
	"core_reachable" boolean DEFAULT false NOT NULL,
	"chain_observed_at" timestamp with time zone,
	"fee_rates" jsonb,
	"fees_observed_at" timestamp with time zone
);
