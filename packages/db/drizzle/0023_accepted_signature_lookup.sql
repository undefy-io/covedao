CREATE INDEX cove_v3_signing_journal_accepted_idx ON cove_v3_signing_journal
  (network, (coalesce(signing_result->>'txid', unsigned_tx_digest))) WHERE signed_at IS NOT NULL;
