CREATE TABLE IF NOT EXISTS "crc_events" (
	"network" text NOT NULL,
	"txid" text NOT NULL,
	"deploy_txid" text NOT NULL,
	"block_height" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_index" integer NOT NULL,
	"confirmed_time" integer,
	"event_json" jsonb NOT NULL,
	CONSTRAINT "crc_events_network_txid_deploy_txid_pk" PRIMARY KEY("network","txid","deploy_txid")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crc_metadata" (
	"network" text NOT NULL,
	"deploy_txid" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"website_url" text,
	"x_url" text,
	"image_url" text,
	"submitted_by_script" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crc_metadata_network_deploy_txid_pk" PRIMARY KEY("network","deploy_txid")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crc_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"operation" text NOT NULL,
	"deployment_txid" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"unsigned_tx_digest" text NOT NULL,
	"psbt_base64" text NOT NULL,
	"wallet_script_hex" text NOT NULL,
	"token_script_hex" text NOT NULL,
	"trusted_json" jsonb NOT NULL,
	"status" text DEFAULT 'BUILT' NOT NULL,
	"signed_psbt_sha256" text,
	"claim_id" uuid,
	"claimed_at" timestamp with time zone,
	"signed_raw_hex" text,
	"txid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '15 minutes' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crc_events_asset_idx" ON "crc_events" USING btree ("network","deploy_txid","block_height" DESC NULLS LAST,"tx_index" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crc_events_block_idx" ON "crc_events" USING btree ("network","block_height");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crc_sessions_idempotency_uq" ON "crc_sessions" USING btree ("network","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crc_sessions_status_idx" ON "crc_sessions" USING btree ("network","status","created_at");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crc_records_vault_idx" ON "crc_records" USING btree ("network", ("value_json"->'vault'->>'txid')) WHERE "kind" = 'assets';
