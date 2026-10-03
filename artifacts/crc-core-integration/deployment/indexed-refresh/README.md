# Indexed frontend refresh

Manual Signet testing found token history required a reload. The replacement had one-time reads and no active status subscription. User correction requires confirmed reads to follow the indexed cursor rather than independent interval polling.

`/api/crc/v1/status` reads only the authoritative CRC cursor from PostgreSQL. A shared browser store polls this small endpoint every five seconds while visible and on focus/return. Token detail, token/global history, token candles, displayed curve price and token sell balance load initially, then refresh only when the network/indexed height/block hash changes. Same-height reorgs count as changes. Failed projections retry on subsequent successful status observations. Background tabs pause requests; cleanup aborts pending reads and removes timers/listeners. Overlapping reads queue only the latest observed cursor.

The explicit trade review, built transaction and signing state survive projection refreshes. Pending/off-chain reads and live signing/broadcast checks are not incorrectly gated solely by a confirmed block hash. The status response reports the indexed tip; it does not pretend that this is a separately observed Core tip.

Tests were written first: the browser regression failed against the deployed one-time reader, and the hidden queued-read regression failed before the visibility guard. Desktop/mobile browser checks verify unchanged status adds no token/history requests, a changed hash at the same height refreshes both, and the explicit trade quote/input remain intact. Independent read-only review found the hidden-tab race; final review reports no remaining actionable findings.

See evidence.json and validation logs for the final deployment and results. Browser interactions use owned regtest fixtures; no user wallet signatures or broadcasts were performed.
