ALTER TABLE cove_crc_market_listings ADD COLUMN IF NOT EXISTS seller_presigned_psbt_base64 text;
UPDATE cove_crc_market_listings SET status = 'STALE', updated_at = now()
  WHERE status = 'OPEN' AND seller_presigned_psbt_base64 IS NULL;
ALTER TABLE cove_crc_market_listings DROP CONSTRAINT IF EXISTS cove_crc_market_open_presigned_ck;
ALTER TABLE cove_crc_market_listings ADD CONSTRAINT cove_crc_market_open_presigned_ck
  CHECK (status NOT IN ('OPEN', 'RESERVED') OR seller_presigned_psbt_base64 IS NOT NULL) NOT VALID;
