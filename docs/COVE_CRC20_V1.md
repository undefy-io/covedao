# Cove CRC-20 v1 transaction format

Status: Cove protocol design for implementation. The standalone `crc20-*` packages are prototypes; this document does not describe the currently deployed V3 transaction format.

## Evidence and scope

The archived Garden sample has 1,950 confirmed transactions: one deploy, 812 mints, and 1,137 transfers. Its transfer markers contain decimal `amt`, and the recipient output immediately follows the marker. Its mint markers omit `amt`; Garden's mint allocation rule is not established. See `artifacts/crc-garden/COMPATIBILITY.md` for the observations and fixtures. The rules below for Cove issuance, fees, asset identity, and curve validity are **Cove choices**, not claims about Garden.

Cove indexes only deployments explicitly registered for this launch service. Neither a ticker nor `cv` proves registration. The asset key is `(Bitcoin network, deployment txid)`; a ticker is display data. A registration becomes active only after the confirmed deploy transaction and its outputs pass the Cove validator. Other CRC assets, including LEAF, do not enter Cove balances or markets.

## Shared envelope

One zero-satoshi OP_RETURN at vout 0 contains one UTF-8 JSON object with `p:"crc-20"`. There is exactly one CRC marker. The JSON payload is at most 256 bytes. Writer field order is fixed as shown below; readers reject duplicate keys, unknown fields, wrong types, noncanonical positive atom strings, unsupported versions, malformed UTF-8, and ambiguous layouts. The marker may exceed legacy 80-byte relay limits; supported node policy and relay acceptance must be tested before activation. Output scripts are stored and compared as bytes, not addresses. Only recognized spendable script types are accepted, with the script-specific dust threshold.

Post-deploy markers carry the lowercase 64-hex `id` of the deployment transaction. This is a Cove extension that disambiguates tokens sharing a ticker. Vault trades must also spend the current vault outpoint in input 0; the `id` must match that vault's registered asset. Peer transfers identify the asset with `id` and must prove the sender from a verified input prevout. No ticker-only fallback is allowed.

## Deploy

```json
{"p":"crc-20","op":"deploy","tick":"COVE","type":"bonding","max":"2100000000000000","cv":"cove-curve-v1"}
```

`max` is decimal atoms for Cove v1: 21,000,000 public tokens at 10^8 atoms per token. The fixed `cove-curve-v1` version rejects any other cap. Outputs: 0 marker; 1 unique asset vault anchor; 2 creator record of exactly 1,000 sats; 3 configured protocol launch fee of exactly 7,000 sats; optional final ordinary change. The registration records the creator, vault, and protocol scripts. The protocol script must match trusted network launch configuration. The deploy and registration must be bound to the same confirmed txid.

## Buy from newly issued supply

```json
{"p":"crc-20","op":"mint","tick":"COVE","amt":"100000000000","id":"<deployment txid>"}
```

Input 0 spends the current vault. Outputs: 0 marker; 1 buyer/token recipient; 2 replacement vault; 3 protocol fee; 4 creator fee; optional final buyer change. `amt` is positive decimal atoms and a multiple of 1,000 display tokens. Mint only when vault token inventory is empty. The replacement vault equals the previous vault sats plus the exact curve reserve delta. The other payment values and scripts must match the versioned quote.

## Buy from vault inventory

Use `op:"transfer"` with the same `tick`, `amt`, and `id` fields and the same input/output positions as a mint buy. The vault is the token sender. Minted lifetime supply stays fixed; inventory falls by `amt`. An order that crosses from inventory to new issuance requires two transactions. Indexing it as a mint or a single mixed operation is invalid.

## Sell to the vault

Use `op:"transfer"` with `tick`, `amt`, and `id`. Input 0 spends the current vault; input 1 must be a seller-authorized, verified prevout. Outputs: 0 marker; 1 replacement vault and token recipient; 2 seller payout; 3 protocol fee; optional final seller change. The replacement vault loses the exact reserve delta. The seller's token balance falls; vault inventory rises. Lifetime minted supply does not fall. There is no creator fee on a sell. Seller payout must satisfy script dust rules; any wallet top-up and miner fee are funded by inputs and checked separately.

## Peer transfer

Use `op:"transfer"` with `tick`, `amt`, and `id`; input 0 is a verified sender prevout, output 0 is the marker, and output 1 is the token recipient. Remaining ordinary outputs may pay BTC or return change, but cannot create another CRC marker. This operation cannot spend a registered current vault input. Sender token balances are keyed by canonical script bytes. A supplied address or unverified prevout is never authority.

## Curve, authorization, and replay

State is minted atoms `M`, vault atoms `V`, and circulating atoms `C=M−V`; vault sats are `anchor+R(C)`. Buy gross is `R(C+q)−R(C)` and sell gross is `R(C)−R(C−q)`. The 210-stage integer price table and fee constants are fixed for `cove-curve-v1`; changing them requires another version. Current fees are buy protocol `5000 + 10×lots + ceil(750×gross/10000)`, buy creator `max(546,ceil(5000×gross/10000))`, and sell protocol `max(1000,ceil(750×gross/10000))`. Miner fees come from verified input-minus-output value, not the reserve.

Indexing uses confirmed raw transactions and authoritative prevouts in block transaction order. Builders and Guardian require signatures committing to all inputs and outputs; the validator must not trust a caller-supplied `assetId`, amount, sender, or destination. Each transaction either applies all curve, balance, and vault changes or none. A confirmed spend of the current vault that fails Cove rules marks the asset unavailable until recovery; it cannot leave the old vault apparently tradable. Reorg rollback includes registration, vault lineage, balances, lifetime supply, and availability. Unknown assets and malformed transactions never credit token balances.

## Implementation gates

Beads `covedao-3v9.1`, `covedao-tnh.1`, `covedao-tnh.2`, `covedao-tnh.3`, and `covedao-3v9.2` track this work. Before production activation, tests must cover forged `cv`, unregistered lookalikes, duplicate tickers, wrong cap/fees/scripts, unauthorized sender, stale vault, mismatched amount and payout, inventory boundary, confirmed invalid vault spend, and reorg replay equality. Relay acceptance for the complete markers and Guardian signing are explicit gates.
