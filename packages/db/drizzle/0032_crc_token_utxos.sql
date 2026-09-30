ALTER TABLE "cove_crc_assets" ADD COLUMN IF NOT EXISTS "protocol_version" integer NOT NULL DEFAULT 1;
ALTER TABLE "cove_crc_assets" ADD COLUMN IF NOT EXISTS "burned_atoms" bigint;
ALTER TABLE "cove_crc_assets" ADD CONSTRAINT "cove_crc_assets_protocol_version_ck" CHECK ("protocol_version" IN (1, 2));
ALTER TABLE "cove_crc_assets" ADD CONSTRAINT "cove_crc_assets_burned_atoms_ck" CHECK (
  ("protocol_version" = 1 AND "burned_atoms" IS NULL) OR
  ("protocol_version" = 2 AND "burned_atoms" IS NOT NULL AND "burned_atoms" >= 0)
);

CREATE TABLE "cove_crc_token_utxos" (
  "network" text NOT NULL,
  "deploy_txid" text NOT NULL,
  "txid" text NOT NULL,
  "vout" integer NOT NULL,
  "script_hex" text NOT NULL,
  "atoms" bigint NOT NULL,
  "created_height" bigint NOT NULL,
  "created_block_hash" text NOT NULL,
  CONSTRAINT "cove_crc_token_utxos_pk" PRIMARY KEY ("network", "deploy_txid", "txid", "vout"),
  CONSTRAINT "cove_crc_token_utxos_amount_ck" CHECK ("atoms" > 0),
  CONSTRAINT "cove_crc_token_utxos_position_ck" CHECK ("vout" >= 0 AND "created_height" >= 0)
);
CREATE UNIQUE INDEX "cove_crc_token_utxos_one_asset_uq" ON "cove_crc_token_utxos" ("network", "txid", "vout");
CREATE INDEX "cove_crc_token_utxos_owner_idx" ON "cove_crc_token_utxos" ("network", "deploy_txid", "script_hex");
