CREATE TABLE IF NOT EXISTS "cove_crc_market_listings" (
  "id" uuid PRIMARY KEY,
  "network" text NOT NULL,
  "deploy_txid" text NOT NULL,
  "ticker" text NOT NULL,
  "seller_script_hex" text NOT NULL,
  "seller_payout_script_hex" text NOT NULL,
  "seller_anchor_txid" text NOT NULL,
  "seller_anchor_vout" integer NOT NULL,
  "seller_anchor_sats" bigint NOT NULL,
  "amount_atoms" numeric(30,0) NOT NULL,
  "price_sats" bigint NOT NULL,
  "protocol_fee_sats" bigint NOT NULL,
  "expires_at_height" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'OPEN',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cove_crc_market_listings_network_ck" CHECK ("network" IN ('mainnet','testnet','signet','regtest')),
  CONSTRAINT "cove_crc_market_listings_status_ck" CHECK ("status" IN ('OPEN','RESERVED','BROADCAST','FILLED','CANCELED','STALE')),
  CONSTRAINT "cove_crc_market_listings_amount_ck" CHECK ("amount_atoms" > 0 AND "price_sats" > 0 AND "protocol_fee_sats" >= 0 AND "seller_anchor_sats" > 0)
);
CREATE INDEX IF NOT EXISTS "cove_crc_market_listings_asset_idx" ON "cove_crc_market_listings" ("network", "deploy_txid", "status", "created_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "cove_crc_market_listings_active_anchor_uq" ON "cove_crc_market_listings" ("network", "seller_anchor_txid", "seller_anchor_vout") WHERE "status" IN ('OPEN','RESERVED','BROADCAST');

CREATE TABLE IF NOT EXISTS "cove_crc_market_fills" (
  "id" uuid PRIMARY KEY,
  "network" text NOT NULL,
  "listing_id" uuid NOT NULL REFERENCES "cove_crc_market_listings" ("id"),
  "buyer_script_hex" text NOT NULL,
  "unsigned_tx_digest" text NOT NULL,
  "psbt_base64" text NOT NULL,
  "buyer_signed_psbt_base64" text,
  "signed_psbt_base64" text,
  "txid" text,
  "status" text NOT NULL DEFAULT 'RESERVED',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  CONSTRAINT "cove_crc_market_fills_network_ck" CHECK ("network" IN ('mainnet','testnet','signet','regtest')),
  CONSTRAINT "cove_crc_market_fills_status_ck" CHECK ("status" IN ('RESERVED','BUYER_SIGNED','SIGNED','BROADCAST','CONFIRMED','REORGED','FAILED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "cove_crc_market_fills_active_uq" ON "cove_crc_market_fills" ("listing_id") WHERE "status" IN ('RESERVED','BUYER_SIGNED','SIGNED','BROADCAST');
CREATE UNIQUE INDEX IF NOT EXISTS "cove_crc_market_fills_txid_uq" ON "cove_crc_market_fills" ("network", "txid") WHERE "txid" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "cove_crc_market_fills_status_idx" ON "cove_crc_market_fills" ("network", "status", "updated_at");
ALTER TABLE "cove_crc_market_fills" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '10 minutes');
ALTER TABLE "cove_crc_market_fills" ADD COLUMN IF NOT EXISTS "buyer_signed_psbt_base64" text;
ALTER TABLE "cove_crc_market_fills" DROP CONSTRAINT IF EXISTS "cove_crc_market_fills_status_ck";
ALTER TABLE "cove_crc_market_fills" ADD CONSTRAINT "cove_crc_market_fills_status_ck" CHECK ("status" IN ('RESERVED','BUYER_SIGNED','SIGNED','BROADCAST','CONFIRMED','REORGED','FAILED'));
DROP INDEX IF EXISTS "cove_crc_market_fills_active_uq";
CREATE UNIQUE INDEX "cove_crc_market_fills_active_uq" ON "cove_crc_market_fills" ("listing_id") WHERE "status" IN ('RESERVED','BUYER_SIGNED','SIGNED','BROADCAST');
CREATE INDEX IF NOT EXISTS "cove_crc_market_fills_expiry_idx" ON "cove_crc_market_fills" ("expires_at") WHERE "status" IN ('RESERVED','BUYER_SIGNED');
