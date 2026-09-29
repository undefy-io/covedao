CREATE TABLE cove_observation_epochs (
  network text PRIMARY KEY,
  chain_generation bigint NOT NULL DEFAULT 0,
  pending_revision bigint NOT NULL DEFAULT 0,
  market_revision bigint NOT NULL DEFAULT 0,
  metadata_revision bigint NOT NULL DEFAULT 0,
  worker_epoch uuid
);
--> statement-breakpoint
INSERT INTO cove_observation_epochs (network) SELECT network FROM cove_v3_cursor ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE cove_pending_backing (
  network text NOT NULL,
  token_id text NOT NULL,
  requested_revision bigint NOT NULL DEFAULT 0,
  observed_revision bigint,
  chain_generation bigint,
  base_txid text,
  base_vout integer,
  payload jsonb,
  observed_at timestamptz,
  last_checked_at timestamptz NOT NULL DEFAULT '1970-01-01 00:00:00+00',
  PRIMARY KEY (network, token_id)
);
--> statement-breakpoint
INSERT INTO cove_pending_backing (network, token_id) SELECT network, token_id FROM cove_v3_tokens ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE INDEX cove_pending_backing_refresh_idx ON cove_pending_backing (network, last_checked_at, token_id);
--> statement-breakpoint
CREATE TABLE cove_transaction_observations (
  network text NOT NULL,
  txid text NOT NULL,
  chain_generation bigint NOT NULL,
  state text NOT NULL,
  block_hash text,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (network, txid)
);
--> statement-breakpoint
CREATE FUNCTION cove_cursor_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n text;
BEGIN
  n := CASE WHEN TG_OP = 'DELETE' THEN OLD.network ELSE NEW.network END;
  INSERT INTO cove_observation_epochs (network, chain_generation) VALUES (n, 1)
  ON CONFLICT (network) DO UPDATE SET chain_generation = cove_observation_epochs.chain_generation + 1;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cove_cursor_generation AFTER INSERT OR UPDATE OR DELETE ON cove_v3_cursor
FOR EACH ROW EXECUTE FUNCTION cove_cursor_generation();
--> statement-breakpoint
CREATE FUNCTION cove_pending_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
  IF TG_TABLE_NAME = 'cove_v3_signing_journal' THEN
    IF NEW.signing_result IS NOT DISTINCT FROM OLD.signing_result THEN RETURN NEW; END IF;
    BEGIN t := (NEW.signing_result->>'resultJson')::jsonb->>'tokenId'; EXCEPTION WHEN others THEN t := NULL; END;
    IF t IS NULL THEN SELECT token_id INTO t FROM cove_v3_backing_states WHERE network = NEW.network AND txid = NEW.backing_txid AND vout = NEW.backing_vout AND canonical LIMIT 1; END IF;
  ELSE
    t := NEW.token_id;
    IF TG_OP = 'UPDATE' AND NEW.raw_tx_hex IS NOT DISTINCT FROM OLD.raw_tx_hex AND NEW.accepted_at IS NOT DISTINCT FROM OLD.accepted_at THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO cove_observation_epochs (network, pending_revision) VALUES (NEW.network, 1)
  ON CONFLICT (network) DO UPDATE SET pending_revision = cove_observation_epochs.pending_revision + 1;
  IF t IS NOT NULL THEN
    INSERT INTO cove_pending_backing (network, token_id, requested_revision) VALUES (NEW.network, t, 1)
    ON CONFLICT (network, token_id) DO UPDATE SET requested_revision = cove_pending_backing.requested_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cove_signed_pending_invalidated AFTER UPDATE ON cove_v3_signing_journal
FOR EACH ROW WHEN (NEW.signed_at IS NOT NULL) EXECUTE FUNCTION cove_pending_invalidated();
--> statement-breakpoint
CREATE TRIGGER cove_submission_pending_invalidated AFTER INSERT OR UPDATE ON cove_v3_submissions
FOR EACH ROW EXECUTE FUNCTION cove_pending_invalidated();
--> statement-breakpoint
CREATE FUNCTION cove_pending_token_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cove_pending_backing (network, token_id) VALUES (NEW.network, NEW.token_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cove_pending_token_created AFTER INSERT ON cove_v3_tokens
FOR EACH ROW EXECUTE FUNCTION cove_pending_token_created();
