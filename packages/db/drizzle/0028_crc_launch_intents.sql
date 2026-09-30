CREATE TABLE IF NOT EXISTS "cove_crc_launch_intents" (
  "network" text NOT NULL,
  "txid" text NOT NULL,
  "ticker" text NOT NULL,
  "signed_raw_hex" text NOT NULL,
  "raw_sha256" text NOT NULL,
  "launch_salt_hex" text NOT NULL,
  "vault_script_hex" text NOT NULL,
  "creator_script_hex" text NOT NULL,
  "protocol_script_hex" text NOT NULL,
  "vault_anchor_sats" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cove_crc_launch_intents_pk" PRIMARY KEY ("network", "txid")
);
CREATE UNIQUE INDEX IF NOT EXISTS "cove_crc_intents_salt_uq" ON "cove_crc_launch_intents" ("network", "launch_salt_hex");
CREATE UNIQUE INDEX IF NOT EXISTS "cove_crc_intents_vault_uq" ON "cove_crc_launch_intents" ("network", "vault_script_hex");
