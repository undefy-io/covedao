DROP TRIGGER cove_signed_pending_invalidated ON cove_v3_signing_journal;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cove_pending_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME <> 'cove_v3_submissions' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.accepted_at IS NULL THEN RETURN NEW; END IF;
  ELSE
    IF NEW.accepted_at IS NULL AND OLD.accepted_at IS NULL THEN RETURN NEW; END IF;
    IF NEW.accepted_at IS NOT DISTINCT FROM OLD.accepted_at
      AND NEW.txid IS NOT DISTINCT FROM OLD.txid
      AND NEW.raw_tx_hex IS NOT DISTINCT FROM OLD.raw_tx_hex THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO cove_observation_epochs (network, pending_revision) VALUES (NEW.network, 1)
  ON CONFLICT (network) DO UPDATE SET pending_revision = cove_observation_epochs.pending_revision + 1;
  IF NEW.token_id IS NOT NULL AND NEW.backing_txid IS NOT NULL AND NEW.backing_vout = 1 THEN
    INSERT INTO cove_pending_backing (network, token_id, requested_revision) VALUES (NEW.network, NEW.token_id, 1)
    ON CONFLICT (network, token_id) DO UPDATE SET requested_revision = cove_pending_backing.requested_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
