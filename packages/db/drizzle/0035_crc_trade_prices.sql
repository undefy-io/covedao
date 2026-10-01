ALTER TABLE "cove_crc_events" ADD COLUMN "trade_side" text;
ALTER TABLE "cove_crc_events" ADD COLUMN "trade_atoms" numeric(39,0);
ALTER TABLE "cove_crc_events" ADD COLUMN "trade_gross_sats" numeric(39,0);
ALTER TABLE "cove_crc_events" ADD COLUMN "confirmed_time" numeric(39,0);
ALTER TABLE "cove_crc_events" ADD CONSTRAINT "cove_crc_events_trade_side_ck" CHECK ("trade_side" IS NULL OR "trade_side" IN ('buy', 'sell'));
CREATE INDEX IF NOT EXISTS "cove_crc_events_trades_idx" ON "cove_crc_events" ("network", "deploy_txid", "block_height", "tx_index") WHERE "trade_gross_sats" IS NOT NULL;
