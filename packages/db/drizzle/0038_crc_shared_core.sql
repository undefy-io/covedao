CREATE TABLE IF NOT EXISTS "crc_authorizations" (
	"network" text NOT NULL,
	"offer_id" text NOT NULL,
	"listed_outpoint" text NOT NULL,
	"offer_json" jsonb NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crc_authorizations_network_offer_id_pk" PRIMARY KEY("network","offer_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crc_checkpoints" (
	"network" text NOT NULL,
	"height" bigint NOT NULL,
	"block_hash" text,
	"baseline" boolean DEFAULT false NOT NULL,
	"state_json" jsonb NOT NULL,
	"state_root" text NOT NULL,
	CONSTRAINT "crc_checkpoints_network_height_pk" PRIMARY KEY("network","height")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crc_cursors" (
	"network" text PRIMARY KEY NOT NULL,
	"height" bigint,
	"block_hash" text,
	"fingerprint" text,
	"state_root" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crc_indexed_blocks" (
	"network" text NOT NULL,
	"height" bigint NOT NULL,
	"hash" text NOT NULL,
	"parent_hash" text NOT NULL,
	"fingerprint" text NOT NULL,
	CONSTRAINT "crc_indexed_blocks_network_height_pk" PRIMARY KEY("network","height")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crc_networks" (
	"network" text PRIMARY KEY NOT NULL,
	"config_json" jsonb NOT NULL,
	"activation_height" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crc_records" (
	"network" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"deploy_txid" text,
	"script_hex" text,
	"atoms" bigint,
	"sats" bigint,
	"status" text,
	CONSTRAINT "crc_records_network_kind_key_pk" PRIMARY KEY("network","kind","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crc_registrations" (
	"network" text NOT NULL,
	"deploy_txid" text NOT NULL,
	"config_json" jsonb NOT NULL,
	"signed_raw_hex" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crc_registrations_network_deploy_txid_pk" PRIMARY KEY("network","deploy_txid")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crc_undo" (
	"network" text NOT NULL,
	"height" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"undo_json" jsonb NOT NULL,
	CONSTRAINT "crc_undo_network_height_pk" PRIMARY KEY("network","height")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crc_authorizations_outpoint_idx" ON "crc_authorizations" USING btree ("network","listed_outpoint");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crc_indexed_blocks_hash_idx" ON "crc_indexed_blocks" USING btree ("network","hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crc_records_wallet_idx" ON "crc_records" USING btree ("network","script_hex","deploy_txid") WHERE "crc_records"."kind" = 'allocations';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crc_records_market_idx" ON "crc_records" USING btree ("network","deploy_txid","status") WHERE "crc_records"."kind" = 'offers';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crc_undo_hash_idx" ON "crc_undo" USING btree ("network","block_hash");
