CREATE TABLE IF NOT EXISTS "cove_crc_signing_journal" (
  "network" text NOT NULL,
  "backing_txid" text NOT NULL,
  "backing_vout" integer NOT NULL,
  "unsigned_tx_digest" text NOT NULL,
  "deploy_txid" text NOT NULL,
  "operation" text NOT NULL,
  "amount_atoms" bigint NOT NULL,
  "gross_sats" bigint NOT NULL,
  "protocol_fee_sats" bigint NOT NULL,
  "miner_fee_sats" bigint NOT NULL,
  "cursor_height" bigint NOT NULL,
  "cursor_hash" text NOT NULL,
  "signing_psbt_base64" text,
  "signed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cove_crc_signing_journal_pk" PRIMARY KEY ("network", "backing_txid", "backing_vout", "unsigned_tx_digest")
);
CREATE INDEX IF NOT EXISTS "cove_crc_signing_journal_asset_idx" ON "cove_crc_signing_journal" ("network", "deploy_txid", "created_at" DESC);
