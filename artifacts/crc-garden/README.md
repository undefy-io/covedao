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

At capture time (2026-09-30 10:16 UTC, tip 969291), the database contains 1,950
events: 1 deploy, 812 mints, and 1,137 transfers. Its first event was on
2026-09-18. These are the site's indexed records, not an independent chain
audit. Later events are outside this snapshot.

Refresh the snapshot with:

```bash
python3 scripts/research/archive-crc-garden-activity.py artifacts/crc-garden/activity-2026-09-30.sqlite
```

The importer checks that each page has the same chain tip and event count,
rechecks the first page after downloading, validates event type totals, and
replaces the SQLite file only after an integrity check passes.

Example queries:

```sql
SELECT kind, COUNT(*) FROM events GROUP BY kind;
SELECT day, events, mints, transfers FROM daily ORDER BY day;
SELECT txid, timestamp, amount_atoms, mint_status
FROM events WHERE kind = 'mint' ORDER BY event_index LIMIT 20;
```
