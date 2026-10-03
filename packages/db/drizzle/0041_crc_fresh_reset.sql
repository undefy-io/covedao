-- Explicit replacement reset: no CRC backfill or compatibility projection.
-- Shared application tables and read-only chain fixtures are untouched.
DROP TABLE IF EXISTS "cove_crc_market_fills";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_market_listings";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_signing_journal";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_build_sessions";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_launch_intents";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_undo";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_token_utxos";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_token_metadata";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_cursor";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_events";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_blocks";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_balances";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_vaults";
--> statement-breakpoint
DROP TABLE IF EXISTS "cove_crc_assets";
--> statement-breakpoint
TRUNCATE TABLE "crc_authorizations", "crc_checkpoints", "crc_cursors", "crc_events", "crc_indexed_blocks", "crc_metadata", "crc_networks", "crc_records", "crc_registrations", "crc_sessions", "crc_signatures", "crc_undo";
