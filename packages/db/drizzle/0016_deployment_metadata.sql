DROP INDEX IF EXISTS "cove_v3_token_metadata_token_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_token_metadata_deploy_uq" ON "cove_v3_token_metadata" ("network", "token_id", "deploy_txid");
--> statement-breakpoint
INSERT INTO cove_v3_token_metadata (network, token_id, display_name, description, website_url, x_url, image_url, submitted_by_script, deploy_txid)
SELECT DISTINCT ON (network, token_id, txid) network, token_id, metadata_json->>'displayName', coalesce(metadata_json->>'description', ''),
  metadata_json->>'websiteUrl', metadata_json->>'xUrl', metadata_json->>'imageUrl', wallet_script, txid
FROM cove_v3_app_transactions
WHERE operation = 'DEPLOY' AND metadata_json->>'displayName' IS NOT NULL AND token_id IS NOT NULL AND txid IS NOT NULL
ORDER BY network, token_id, txid, updated_at DESC
ON CONFLICT (network, token_id, deploy_txid) DO NOTHING;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cove_v3_submissions_accepted_idx ON cove_v3_submissions (network, accepted_at DESC) WHERE accepted_at IS NOT NULL;
