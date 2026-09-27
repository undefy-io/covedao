ALTER TABLE "cove_v3_signing_journal" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
-- Existing reservations may already have produced signatures. Preserve their conflict barriers.
UPDATE "cove_v3_signing_journal" SET "signed_at" = "committed_at";
