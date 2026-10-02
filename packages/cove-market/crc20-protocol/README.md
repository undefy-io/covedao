# Isolated CRC protocol

The public entry point is `index.ts`. Nothing outside this directory is integrated or changed. `SPEC.md` defines the protocol stories and fee policy; `VERIFICATION.md` maps them to the tests and records the evidence.

Run the isolated checks from the repository root:

```sh
bash packages/cove-market/crc20-protocol/test-support/check.sh
```

The suite uses the existing TypeScript, Vitest, bitcoinjs-lib and tiny-secp256k1 dependencies. Docker must be available and the local `bitcoin/bitcoin:30.0` image must exist. Missing prerequisites fail the suite. Each run creates a new container with `--network none`, no published ports, two separate Core wallets, and a temporary data directory under `.regtest/`. Blocks are mined immediately with `generatetoaddress`. The container and data directory are removed after the tests.

## Public functions

- `parseAtoms`, `markerScript`, `decodeTransaction`, `parseRawTransaction`: canonical bigint amounts, exact Garden-shaped marker bytes, output positions, and raw Bitcoin parsing.
- `backingSats`, `quoteBuy`, `quoteSell`, `marketFee`: integer-only stairs210 backing and Cove fee calculations. Curve trades require 100-token increments; the price and prorated fee unit remains 1,000 tokens; wallet transfers and market orders permit arbitrary positive atom amounts.
- `buildDeploy`, `buildMint`, `buildTransfer`, `buildSell`, `buildInventoryBuy`, `buildListing`, `buildPurchase`, `buildCancel`: explicit transaction plans containing inputs, ordered output scripts and satoshis, carrier allocations, fees and BTC change. Every action returns exactly one transaction plan. Builders require adequate BTC funding and refuse miner fees above 20,000 sats.
- `authorizeOffer`, `verifyOffer`, `registerOffer`, `offerId`: signatures bind the network, deploy txid, ticker, exact outpoint, amount, carrier value, seller script, total price and expiry. Authorization also produces the seller's native SegWit `SINGLE|ANYONECANPAY` witness for input 0 and seller payout at output 0. `buildPurchase` attaches that witness; the buyer signs the remaining inputs with `SIGHASH_ALL`. For a signed offer, callers must supply `currentHeight` and the latest registered offer status; construction rejects missing/invalid heights, expiry and unavailable offers. The regtest purchase needs only Bob's wallet at fill time.
- `validateFinalTransaction`: checks the signed raw transaction against the quoted plan, including every input, output, marker, recipient, witness signature and actual miner fee. Call before broadcast.
- `emptyLedger`, `applyBlock`, `rollbackBlock`: immutable strict replay of ordered protocol transactions using raw hex and actual prevouts. Mint amounts are derived from the backing transition rather than supplied as ledger metadata. Duplicate blocks are idempotent only when their contents agree; detached blocks, replayed spends and protocol-invalid transactions throw. Rollback restores the complete prior state, including offer status.
- `markOfferUnavailable`: records pending cancellation without spending or removing any token allocation. Only the confirmed spend establishes cancellation; an already-authorized fill can still win the Bitcoin race.

## Boundaries

This isolated implementation registers native P2WPKH deployment, vault, wallet and fee scripts. Its signature verifier supports `SIGHASH_ALL`, plus the registered market input's `SINGLE|ANYONECANPAY` authorization. The generic Garden wire decoder and raw parser also read the archive's Taproot outputs, but the isolated ledger does not claim Taproot covenant or Guardian integration. A registered vault script must still be signed by its controller; pure protocol validation does not replace Bitcoin custody or consensus enforcement.

`applyBlock` is a strict protocol replay API, not a complete Bitcoin indexer. Its transaction list contains protocol transactions with actual prevouts; the test adapter omits coinbase. Supply and ownership rules require the registered configuration and, for market fills, the previously verified offer. Raw marker JSON alone cannot reconstruct missing offer terms. Canonical block selection and prevout retrieval belong to the caller. No existing backend, frontend, indexer or Guardian has been connected to this API.

Offer expiry and unavailable status control new purchase construction; they cannot revoke the seller's existing Bitcoin signature. Replay honors otherwise valid confirmed fills at or after expiry, including fills delayed in the mempool or confirmed while cancellation is pending. Only a confirmed competing spend invalidates the presigned input. Ordinary owner-signed transfers and curve sales remain valid for listed carriers. Every accepted spend retires all offers on its consumed token outputs; a market fill records `filled`, and other spends record `cancelled`. Rollback restores the previous allocations and offer statuses.

Runtime source uses Uint8Array and browser APIs without Node imports, Buffer or process globals. The browser test bundles the dependency's browser branch and runs signing and verification without Node polyfills. Consumers must support tiny-secp256k1's WebAssembly module imports. Core RPC, SQLite access and the browser test's WASM bundler adapter are test-only.

## Garden compatibility

The SQLite archives are opened with `mode=ro`. Tests recompute all 1,950 activity txids and every archived parent txid, compare all raw output scripts and values, verify marker bytes and field order, and check reported recipients against output scripts. All 812 mint markers omit amounts; all 1,137 transfer markers contain canonical `amt` and have the reported recipient immediately after the marker. All 159 BTC-funded mints have the pinned marker/carrier/payment layout. There are 743 transfers with 1,000-sat recipient carriers; other archived carriers have different values.

Eight ORDI-funded mints are an explicit exception to a universal mint-recipient rule: output 1 after the marker is payment, while the archive reports the beneficiary at output 2. Cove's BTC-only mint layout does not implement these Garden payment modes.

The archives do **not** prove Garden's issuance formula, token ownership or change-allocation rules, validator acceptance, marketplace authorization/cancellation semantics, fee policy, reserve accounting, or acceptance of Cove-issued assets. Reported mint amounts are observations, not information encoded in the amountless marker. Passing this suite proves the specified isolated Cove behavior and observed Garden wire shapes, not Garden's unpublished ledger rules or integration with the existing app.

## Small trades and transaction compliance

`small-curve.test.ts` confirms buys of 500 + 500 tokens followed by both sell paths, 400 + 600 and 1,000, then two 500-token reserve buys. Integer backing rounding makes the first buys cost 14 and 13 sats; the platform fees are 5,007 and 5,006 sats, and creator fees are 546 sats each. Sales charge 1,000 platform sats and zero creator fee, with explicit wallet top-up for these small backing values. Fee and raw-output details are emitted to `small-curve-fees.json`.

The test-only `checkGardenCompliance` loads deploy, BTC-mint and transfer examples plus their prevouts from read-only SQLite. Every confirmed transaction in both regtest suites passes this checker. `compliance-report.json` covers the original 18 transactions; `small-curve-compliance.json` covers the 13 small-trade transactions. Both reports enumerate each input and output, its Garden reference where present, and intentional differences. Shared-format compliance is separate from exact transaction equality or Garden ledger acceptance. Cove fee outputs, native SegWit scripts, deployment values, carrier amounts and extra change outputs are explicitly identified as Cove choices.
