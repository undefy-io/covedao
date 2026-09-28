CREATE TABLE IF NOT EXISTS "cove_v3_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"token_id" text,
	"backing_txid" text,
	"backing_vout" integer,
	"unsigned_tx_digest" text NOT NULL,
	"wallet_psbt_base64" text NOT NULL,
	"raw_tx_hex" text,
	"txid" text,
	"phase" text DEFAULT 'SIGNING' NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "cove_v3_app_tx_txid_uq";--> statement-breakpoint
ALTER TABLE "cove_v3_signing_journal" ADD COLUMN "signing_result" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cove_v3_submission_source_uq" ON "cove_v3_submissions" USING btree ("network","source_kind","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_submission_txid_idx" ON "cove_v3_submissions" USING btree ("network","txid") WHERE "cove_v3_submissions"."txid" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_submission_due_idx" ON "cove_v3_submissions" USING btree ("network","next_attempt_at","id") WHERE "cove_v3_submissions"."phase" <> 'BROADCAST';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cove_v3_app_tx_txid_idx" ON "cove_v3_app_transactions" USING btree ("network","txid") WHERE "cove_v3_app_transactions"."txid" IS NOT NULL;