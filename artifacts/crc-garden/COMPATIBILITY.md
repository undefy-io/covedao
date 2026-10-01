# LEAF CRC-20 on-chain layout and Cove compatibility

This report compares the 1,950 events in the 2026-09-30 `crc.garden/activity`
snapshot with their confirmed Bitcoin mainnet transactions. The SQLite database
contains the site's event JSON, Bitcoin Core's full verbose transaction JSON and
raw transaction hex, and all 10,310 normalized outputs. Each transaction ID and
block hash matched the site's record, all were in the active chain, and SQLite's
integrity check passed. The site is a **LEAF** ledger; this is not a published
general CRC-20 validation specification.

## Observed operations

| Activity | Transactions | CRC-20 marker position | Other OP_RETURN |
| --- | ---: | --- | --- |
| Deploy | 1 | vout 0 | None |
| Mint paid with BTC | 159 | vout 0 | None |
| Mint paid with LEAF | 645 | vout 2 | ICO-20 transfer at vout 0 |
| Mint paid with ORDI | 8 | vout 0 | None |
| Transfer | 1,137 | vout 0 in 314; vout 1 in 823 | None |

Every event has exactly one zero-value CRC-20 JSON OP_RETURN. The 645 LEAF-funded
mints have a second, ICO-20 OP_RETURN in the **same Bitcoin transaction**. No
activity event represents a separate JSON transaction.

### Deploy

The [LEAF deploy transaction](https://mempool.space/tx/546cc042d0f396a0d8ad67b6987d9d5c09619e6962738347ca1611a1d1841b67)
puts JSON at vout 0:

```json
{"p":"crc-20","op":"deploy","tick":"LEAF","type":"bonding","max":"100000000","lim":"2100000000","leaf":"1","ordi":"286","btc":"3333333"}
```

This single example establishes LEAF's on-chain shape, not which fields another
ticker's indexer would require.

### Mint

All 812 mint markers are exactly `{"p":"crc-20","op":"mint","tick":"LEAF"}`.
None carries an amount. The site reports the minted amount separately in its
event API; the payment and token recipient are visible through the transaction
and indexed state.

| Payment asset | Count | Observed output layout |
| --- | ---: | --- |
| BTC | 159 | CRC marker vout 0; recipient 330-sat output vout 1; BTC payment to a single vault address at vout 2; change at vout 3. The API's payment sats equal vout 2 in all 159. |
| LEAF | 645 | ICO-20 transfer vout 0; 546-sat output vout 1; CRC mint vout 2; recipient 330-sat output vout 3; 10,000-sat vault output vout 4; change vout 5. The ICO amount in whole/decimal LEAF units times 10^8 equals the API's payment atoms in all 645. |
| ORDI | 8 | CRC mint vout 0; vault/payment output vout 1; recipient 330-sat output vout 2; change vout 3. ORDI transfer amount cannot be validated from output values alone. |

Examples: [BTC-funded mint](https://mempool.space/tx/2603dc258c0f422ff9a33f1a0c5d93a38660131cb5bf2093fb99f72eb1f6c289),
[LEAF-funded mint](https://mempool.space/tx/394bdb537c5c1e7a11fe95230cafda2394911b86a054ca1c974bcfed5b7c8feb),
and [ORDI-funded mint](https://mempool.space/tx/d1a64d8051ae24c2032b146ecb63a789dae7b2fe584f46505f874070008027fd).
The on-chain outputs and public event API do not disclose the complete mint
validation or price formula; that would require the indexer's rules and the
external asset histories.

### Transfer

Every transfer marker has `p`, `op`, `tick`, and `amt`. For all 1,137 transfers,
`amt` exactly equals the site's `amount_atoms` string. The address on the output
**immediately after** the CRC marker equals the site's recipient in all 1,137.
That recipient output carries 294–1,000 sats across this corpus; it is the
spendable output associated with the marker, not the zero-value OP_RETURN.

Transfer layouts vary:

- 314 put the marker at vout 0: 264 have 3 outputs and 50 have 4.
- 823 put the marker at vout 1: 80 have 4 outputs and 743 have 6. These often
  combine another BTC payment or market settlement with the token transfer.

Examples: [marker at vout 0](https://mempool.space/tx/e0b7e317a6311432bd3f03e9f8536b4dfed0625ddf5b96f5b1c6bc25bdb8ee2f)
and [marker at vout 1](https://mempool.space/tx/74f40f8732201bd8dbdfe6c5868cce993438f43a482f7953e760103aedc0b8a7).

## Cove comparison

The current Cove transaction profile is specified in
[COVE_CRC20_GARDEN_WIRE.md](../../docs/COVE_CRC20_GARDEN_WIRE.md). The regression
tests compare raw Garden mint and sale transactions with generated Cove
transactions for marker fields, position, and recipient adjacency. Cove's
deployment now uses the same nine field names and ordering, with Cove-specific
values. The Cove indexer and Guardian apply Cove's registered-asset and curve
rules; this corpus is a wire-format reference, not an external ledger oracle.
