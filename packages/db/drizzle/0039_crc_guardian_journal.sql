CREATE TABLE IF NOT EXISTS "crc_signatures" (
	"network" text NOT NULL,
	"backing_outpoint" text NOT NULL,
	"unsigned_digest" text NOT NULL,
	"deploy_txid" text NOT NULL,
	"state_root" text NOT NULL,
	"claim_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"signed_psbt_base64" text,
	CONSTRAINT "crc_signatures_network_backing_outpoint_unsigned_digest_pk" PRIMARY KEY("network","backing_outpoint","unsigned_digest")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crc_signatures_claim_idx" ON "crc_signatures" USING btree ("claim_id");