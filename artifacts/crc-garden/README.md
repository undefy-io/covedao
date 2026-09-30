# crc.garden activity snapshot

`activity-2026-09-30.sqlite` contains the public LEAF CRC-20 ledger shown at
[crc.garden/activity](https://crc.garden/activity). The page initially renders
12 rows and loads the rest from `/api/crc20/events?cursor=N&limit=50` as the
ledger scrolls. This snapshot used all 39 API pages available at capture time.

The `capture` table records the API source, generation time, Bitcoin mainnet
tip height, advertised count, and event type counts. The `events` table has one
row per API event, ordered by `event_index`, with the complete original event in
`raw_json`. The `daily` table stores the site's 13 daily aggregate records and
their original JSON. Amounts in atoms are stored as text to preserve integer
precision.

The `transactions` and `outputs` tables contain all 1,950 confirmed Bitcoin
transactions and all 10,310 outputs behind those events. `transactions.raw_json`
preserves Bitcoin Core's verbose transaction response, including its raw hex,
inputs, and witnesses. `outputs` provides each output's satoshi value, address,
script bytes, and decoded single-push OP_RETURN payload when available. Every
returned transaction ID and block hash was checked against the activity row;
Bitcoin Core reported all 1,950 transactions in the active chain.

At capture time (2026-09-30 10:16 UTC, tip 969291), the database contains 1,950
events: 1 deploy, 812 mints, and 1,137 transfers. Its first event was on
2026-09-18. Transaction outputs were fetched at 10:43 UTC. These are the site's
indexed records paired with independently fetched on-chain transactions; later
events are outside this snapshot.

Refresh the activity snapshot and transaction outputs with:

```bash
python3 scripts/research/archive-crc-garden-activity.py artifacts/crc-garden/activity-2026-09-30.sqlite
python3 scripts/research/enrich-crc-garden-outputs.py artifacts/crc-garden/activity-2026-09-30.sqlite
```

The importer checks that each page has the same chain tip and event count,
rechecks the first page after downloading, validates event type totals, and
replaces the SQLite file only after an integrity check passes. Replacing the
activity file removes previous output enrichment, so run both commands in order.
The output importer resumes from missing transactions if interrupted.

Example queries:

```sql
SELECT kind, COUNT(*) FROM events GROUP BY kind;
SELECT day, events, mints, transfers FROM daily ORDER BY day;
SELECT txid, timestamp, amount_atoms, mint_status
FROM events WHERE kind = 'mint' ORDER BY event_index LIMIT 20;
SELECT e.kind, o.vout, o.op_return_text
FROM events e JOIN outputs o USING (txid)
WHERE o.op_return_text IS NOT NULL ORDER BY e.event_index, o.vout LIMIT 20;
```

See [the full-corpus comparison](./COMPATIBILITY.md) for the observed mint and
transfer layouts and what they imply for Cove interoperability.
