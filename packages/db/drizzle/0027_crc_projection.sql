CREATE TABLE IF NOT EXISTS "cove_crc_assets" (
  "network" text NOT NULL,
  "deploy_txid" text NOT NULL,
  "ticker" text NOT NULL,
  "deploy_height" bigint NOT NULL,
  "deploy_block_hash" text NOT NULL,
  "launch_salt_hex" text NOT NULL,
  "creator_script_hex" text NOT NULL,
  "protocol_script_hex" text NOT NULL,
  CONSTRAINT "cove_crc_assets_pk" PRIMARY KEY ("network", "deploy_txid")
);
CREATE INDEX IF NOT EXISTS "cove_crc_assets_ticker_idx" ON "cove_crc_assets" ("network", "ticker");
CREATE INDEX IF NOT EXISTS "cove_crc_assets_catalog_idx" ON "cove_crc_assets" ("network", "deploy_height" DESC, "deploy_txid" DESC);
CREATE TABLE IF NOT EXISTS "cove_crc_vaults" (
  "network" text NOT NULL,
  "deploy_txid" text NOT NULL,
  "txid" text NOT NULL,
  "vout" integer NOT NULL,
  "script_hex" text NOT NULL,
  "btc_sats" bigint NOT NULL,
  "minted_atoms" bigint NOT NULL,
  "inventory_atoms" bigint NOT NULL,
  "availability" text NOT NULL,
  CONSTRAINT "cove_crc_vaults_pk" PRIMARY KEY ("network", "deploy_txid")
);
CREATE INDEX IF NOT EXISTS "cove_crc_vaults_outpoint_idx" ON "cove_crc_vaults" ("network", "txid", "vout");
CREATE TABLE IF NOT EXISTS "cove_crc_balances" (
  "network" text NOT NULL,
  "deploy_txid" text NOT NULL,
  "script_hex" text NOT NULL,
  "atoms" bigint NOT NULL,
  CONSTRAINT "cove_crc_balances_pk" PRIMARY KEY ("network", "deploy_txid", "script_hex")
);
CREATE INDEX IF NOT EXISTS "cove_crc_balances_owner_idx" ON "cove_crc_balances" ("network", "script_hex");
CREATE INDEX IF NOT EXISTS "cove_crc_balances_wallet_idx" ON "cove_crc_balances" ("network", "script_hex", "atoms" DESC, "deploy_txid" DESC);
CREATE TABLE IF NOT EXISTS "cove_crc_blocks" (
  "network" text NOT NULL,
  "height" bigint NOT NULL,
  "hash" text NOT NULL,
  "parent_hash" text NOT NULL,
  "state_root" text NOT NULL,
  CONSTRAINT "cove_crc_blocks_pk" PRIMARY KEY ("network", "height")
);
CREATE TABLE IF NOT EXISTS "cove_crc_events" (
  "network" text NOT NULL,
  "txid" text NOT NULL,
  "block_height" bigint NOT NULL,
  "block_hash" text NOT NULL,
  "tx_index" integer NOT NULL,
  "operation" text,
  "status" text NOT NULL,
  "valid" boolean NOT NULL,
  "reason" text,
  "deploy_txid" text,
  "amount_atoms" bigint,
  CONSTRAINT "cove_crc_events_pk" PRIMARY KEY ("network", "txid")
);
CREATE INDEX IF NOT EXISTS "cove_crc_events_asset_idx" ON "cove_crc_events" ("network", "deploy_txid", "block_height");
CREATE TABLE IF NOT EXISTS "cove_crc_cursor" (
  "network" text NOT NULL PRIMARY KEY,
  "height" bigint NOT NULL,
  "block_hash" text NOT NULL,
  "state_root" text NOT NULL
);
CREATE TABLE IF NOT EXISTS "cove_crc_undo" (
  "network" text NOT NULL,
  "height" bigint NOT NULL,
  "block_hash" text NOT NULL,
  "prior_height" bigint,
  "prior_hash" text,
  "prior_root" text NOT NULL,
  "undo_json" jsonb NOT NULL,
  CONSTRAINT "cove_crc_undo_pk" PRIMARY KEY ("network", "height")
);
