CREATE TABLE cove_watched_inputs (
  network text NOT NULL,
  source_id text NOT NULL,
  txid text NOT NULL,
  vout integer NOT NULL,
  PRIMARY KEY (network, source_id, txid, vout)
);
--> statement-breakpoint
CREATE INDEX cove_watched_inputs_outpoint_idx ON cove_watched_inputs (network, txid, vout);
--> statement-breakpoint
CREATE TABLE cove_indexed_spends (
  network text NOT NULL,
  txid text NOT NULL,
  vout integer NOT NULL,
  spender_txid text NOT NULL,
  block_hash text NOT NULL,
  block_height bigint NOT NULL,
  PRIMARY KEY (network, txid, vout, block_hash)
);
--> statement-breakpoint
CREATE TABLE cove_backing_proofs (
  network text NOT NULL,
  token_id text NOT NULL,
  txid text NOT NULL,
  vout integer NOT NULL,
  block_hash text NOT NULL,
  block_height bigint NOT NULL,
  PRIMARY KEY (network, token_id)
);
