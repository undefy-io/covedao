CREATE TABLE IF NOT EXISTS "cove_crc_token_metadata" (
  "network" text NOT NULL,
  "deploy_txid" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "website_url" text,
  "x_url" text,
  "image_url" text,
  "submitted_by_script" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cove_crc_token_metadata_pk" PRIMARY KEY ("network", "deploy_txid")
);
