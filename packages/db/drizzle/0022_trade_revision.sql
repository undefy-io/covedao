ALTER TABLE cove_observation_epochs ADD COLUMN trade_revision bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE FUNCTION cove_trade_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n text;
BEGIN
  n := CASE WHEN TG_OP = 'DELETE' THEN OLD.network ELSE NEW.network END;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  INSERT INTO cove_observation_epochs (network, trade_revision) VALUES (n, 1)
  ON CONFLICT (network) DO UPDATE SET trade_revision = cove_observation_epochs.trade_revision + 1;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cove_market_trade_revision AFTER INSERT OR UPDATE OR DELETE ON cove_v3_market_trades FOR EACH ROW EXECUTE FUNCTION cove_trade_revision();
