DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cove_crc_assets WHERE protocol_version <> 3) THEN
    RAISE EXCEPTION 'Old Cove CRC assets must be removed before enabling the Garden-shaped wire format';
  END IF;
END $$;

ALTER TABLE "cove_crc_assets" DROP CONSTRAINT "cove_crc_assets_protocol_version_ck";
ALTER TABLE "cove_crc_assets" DROP CONSTRAINT "cove_crc_assets_burned_atoms_ck";
ALTER TABLE "cove_crc_assets" ALTER COLUMN "protocol_version" SET DEFAULT 3;
ALTER TABLE "cove_crc_assets" ADD CONSTRAINT "cove_crc_assets_protocol_version_ck" CHECK ("protocol_version" = 3);
ALTER TABLE "cove_crc_assets" ADD CONSTRAINT "cove_crc_assets_burned_atoms_ck" CHECK ("burned_atoms" IS NOT NULL AND "burned_atoms" >= 0);
