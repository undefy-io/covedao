ALTER TABLE cove_v3_submissions ADD COLUMN conflict_generation bigint;
--> statement-breakpoint
ALTER TABLE cove_v3_submissions ADD COLUMN conflicted boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE FUNCTION cove_public_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n text;
BEGIN
  n := CASE WHEN TG_OP = 'DELETE' THEN OLD.network ELSE NEW.network END;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  INSERT INTO cove_observation_epochs (network) VALUES (n) ON CONFLICT DO NOTHING;
  IF TG_TABLE_NAME = 'cove_v3_token_metadata' THEN
    UPDATE cove_observation_epochs SET metadata_revision = metadata_revision + 1 WHERE network = n;
  ELSIF TG_TABLE_NAME = 'cove_v3_app_transactions' THEN
    IF TG_OP <> 'UPDATE' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.txid IS DISTINCT FROM OLD.txid THEN
      UPDATE cove_observation_epochs SET pending_revision = pending_revision + 1 WHERE network = n;
    END IF;
  ELSE
    UPDATE cove_observation_epochs SET market_revision = market_revision + 1 WHERE network = n;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cove_market_listing_revision AFTER INSERT OR UPDATE OR DELETE ON cove_v3_market_listings FOR EACH ROW EXECUTE FUNCTION cove_public_revision();
--> statement-breakpoint
CREATE TRIGGER cove_market_fill_revision AFTER INSERT OR UPDATE OR DELETE ON cove_v3_market_fills FOR EACH ROW EXECUTE FUNCTION cove_public_revision();
--> statement-breakpoint
CREATE TRIGGER cove_metadata_revision AFTER INSERT OR UPDATE OR DELETE ON cove_v3_token_metadata FOR EACH ROW EXECUTE FUNCTION cove_public_revision();
--> statement-breakpoint
CREATE TRIGGER cove_session_revision AFTER INSERT OR UPDATE OR DELETE ON cove_v3_app_transactions FOR EACH ROW EXECUTE FUNCTION cove_public_revision();
