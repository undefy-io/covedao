# Cove CRC-20 Garden wire profile

## Evidence and scope

The archived 1,950 confirmed Garden LEAF transactions in
`packages/crc20-base/test/fixtures/leaf-mainnet.json` show one CRC-20 JSON
marker per transaction. The parser tests check every raw transaction ID,
operation, transfer amount, and transfer recipient. The transaction tests use
the archived SQLite event and output tables to compare Cove's layout with all
159 BTC-paid mints and 743 payment-first transfers; they also check the site's
reported recipient and BTC payment against the corresponding Bitcoin outputs.
Run `pnpm test:garden-corpus` to verify the focused fixtures still match the
SQLite archive and rerun the transaction comparisons. This evidence describes
the observed LEAF wire shape. It does not disclose Garden's general ticker
registration, mint pricing, or balance validation rules, so acceptance by
Garden's indexer is unproven.

The new Cove profile targets the observed CRC marker fields and recipient
adjacency for Cove-issued assets. Cove's curve, fees, vault and UTXO-bound token
ownership remain Cove rules. An asset is identified by `(network, deploy txid)`
in Cove's registered deployment table; the ticker alone is never an asset key.
The earlier Cove CRC format is retired. Existing signet CRC data must be reset
and a fresh deployment created; old transactions are not reinterpreted.

## Marker bytes and output layout

The writer encodes compact UTF-8 JSON with the field order shown below, a
single zero-sat OP_RETURN, and no duplicate or extra fields in mint or transfer
markers. All amounts are canonical positive decimal atom strings.

| Operation | JSON | Required outputs |
| --- | --- | --- |
| Cove deploy | `{"p":"crc-20","op":"deploy","tick":"TICK","type":"bonding","max":"2100000000000000","cv":"cove-curve-v3"}` | Marker vout 0; registered vault anchor vout 1; creator and protocol outputs follow. The `cv` field selects Cove's curve and ownership profile. Garden's acceptance of this deploy is unknown. |
| Curve mint | `{"p":"crc-20","op":"mint","tick":"TICK"}` | Marker vout 0; recipient token carrier vout 1; successor vault vout 2; protocol fee vout 3; creator fee vout 4; optional BTC change follows. |
| Inventory buy | `{"p":"crc-20","op":"transfer","tick":"TICK","amt":"ATOMS"}` | Marker vout 0; buyer token carrier vout 1; successor vault vout 2; fees and change follow. |
| Curve sell | Same four-field transfer marker | Marker vout 0; successor vault token carrier vout 1; seller BTC payout vout 2; fee vout 3; optional token change at the fixed vout 4 and BTC change follow. |
| Peer transfer | Same four-field transfer marker | Marker vout 0; recipient token carrier vout 1; token change at fixed vout 2 only when input atoms exceed `amt`; optional BTC change follows. |
| Exact market fill | Same four-field transfer marker | Seller BTC payout vout 0; marker vout 1; buyer token carrier vout 2; protocol fee vout 3; optional BTC change follows. |

The market output order matches the confirmed Garden sales cited in
`artifacts/crc-garden/COMPATIBILITY.md`. It does not copy Garden's reusable
`SIGHASH_SINGLE|ANYONECANPAY` seller signatures. Cove's fill spends the exact
listed token-bearing outpoint at input 0, with buyer funding inputs after it;
both sign the complete transaction with `SIGHASH_ALL` or Taproot default.
Spending or replacing that listed outpoint prevents the signed fill from
confirming. Buyer review and Guardian must verify the entire transaction
before signing or broadcasting.

## Deterministic indexing without marker extensions

For a curve operation, input 0 must be the registered current vault outpoint.
For a peer transfer or market fill, input 0 must be a live token-bearing
outpoint. The indexer derives the deployment from that outpoint and rejects
mixed-asset inputs and a marker ticker mismatch. It never resolves an unknown
marker by ticker, and it never credits a transaction that spends no known
token or vault outpoint.

For amountless mint, derive the token amount from the unique legal 1,000-token
lot count whose `quoteBuy(currentCurve, lots)` gross equals the successor vault
reserve delta. Search the bounded supply domain, then require the exact
protocol and creator fees, recipient, successor vault, and valid curve
transition. Reject zero or multiple matching lots. The current Cove backing
function rises by at least 27 sats per lot, making the gross strictly
increasing in the valid mint domain. The same amount must be independently
derived by Guardian from its canonical vault observation.

For transfer, `amt` is the recipient amount. The indexer obtains total input
atoms from its UTXO table. If input atoms exceed `amt`, it requires exactly one
token change output at the operation's fixed position, owned by the input
script, with the exact remainder. No JSON `ch` field is needed. If the full
input allocation is transferred, no token change allocation exists even if an
ordinary BTC change output has the same script.

A fresh signet and mainnet deployment selects this wire profile through its
deploy marker. The old CRC dialect (`amt`, `id`, `v`, optional `ch`) is not
accepted by the current indexer or Guardian.
