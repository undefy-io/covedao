# Verification evidence

The current full isolated run passes **173 tests in 28 files**, including 26 inventory-first regressions and all 1,950 read-only SQLite comparisons. The run takes approximately 110 seconds on this workspace, including Docker startup and cleanup. Blocks are generated on demand; no ten-minute block interval is used. Current consumer integration for mixed purchases remains separately tracked in Beads `covedao-8w1`.

`test-support/check.sh` runs the suite, strict TypeScript checks over runtime and test support, ESLint and formatting checks. `verification.log`, `typecheck.log` and `lint.log` retain the command results. A nonzero exit fails the check script.

## TDD record

Before the public implementation existed, `tdd-red.log` recorded 27 failed tests and one passing archive baseline. Failures reported the missing `index.ts` API. The public implementation was then added to satisfy those tests. Additional recorded failures drove seller-presigned purchases (`tdd-presign-red.log`), block-content replay checks (`tdd-hardening-red.log`), quoted-plan validation (`tdd-final-validation-red.log`), and seller/recipient identity checks (`tdd-owner-red.log`). `tdd-hash-red.log` records the missing browser hash primitive module. These historical failing runs are retained alongside the passing final run.

## Requirement audit

| Requirement                                          | Authoritative checks                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Garden deploy, BTC mint, sale and custom-amount sale | `protocol.test.ts` pins the four named txids, exact marker strings, output positions and independent satoshi values. `archive.test.ts` compares their complete raw scripts, values and recipient addresses with SQLite.                                                                                                                                                                                                                                                    |
| All 1,950 Garden transactions and prevouts           | `archive.test.ts` independently decodes raw transactions with bitcoinjs-lib and the public parser, recomputes activity and parent txids, checks all outputs and 5,190 input values, and verifies deploy/mint/transfer field order. No activity input lacks an archived parent.                                                                                                                                                                                             |
| Canonical amounts and exact arithmetic               | `rules.test.ts` covers zero, negatives, fractions, exponent notation, noncanonical strings, one atom, 123,456,789 atoms, exact full balance and values above JavaScript's safe integer limit. Builders preserve bigint values and reject amounts greater than balance.                                                                                                                                                                                                     |
| Curve and fees                                       | Independent literal vectors cover the first stair, stair boundary, full cap, launch 7,000 sats, 2,000-token gross 54 sats / protocol 5,025 / creator 546, sell gross 27 / protocol 1,000 / economic -973, reserve-buy fees, and marketplace fees 1,000 and 1,501. The 100-token execution increment is enforced; 1,000 tokens remain the pricing/fee unit.                                                                                                                 |
| Real deploy and mints with two wallets               | `regtest.test.ts` broadcasts and confirms deployment and Alice's mint, then independently confirms Alice and Bob minting into their respective carriers in a second deployment. Balances, supply, backing and every raw output are checked.                                                                                                                                                                                                                                |
| Arbitrary transfers and token change                 | Core confirms Alice transferring 500 of 2,000 tokens to Bob and returning 1,500 to Alice. Pure builder tests cover one atom, 123,456,789 atoms, full balance and multiple token inputs. Re-signed transactions with missing inputs, missing change, redirected change or excess marker amount are Bitcoin-valid but rejected by the protocol.                                                                                                                              |
| Curve sell and reserve inventory buy                 | Core confirms selling 1,000 from Alice's 1,500-token carrier, returning 500, increasing inventory, releasing 27 backing sats and charging 1,000 protocol sats with explicit wallet top-up. Bob's inventory purchase reduces inventory and restores backing without increasing issued supply. Insufficient backing, stale spends, sub-100-token or non-100-token-increment curve trades are rejected. Inventory-first mixed purchases are covered by the added suite below. |
| One-transaction listing and purchase                 | Core confirms a listing spending exactly 2,000 tokens into a 500-token sale carrier and 1,500-token change. One subsequent purchase pays Alice 13,347 sats (12,347 price plus 1,000 recovered carrier), creates Bob's carrier and pays the 1,000-sat market fee. Repeated with 123,456,789 atoms at 20,001 sats and a 1,501-sat fee.                                                                                                                                       |
| Seller authorization and altered terms               | Signed offers bind the exact network, deployment, outpoint, amount, payout, price and expiry. Core purchases use the seller's presigned input; Bob alone signs at fill time. Changed amount, recipient, payout and fee invalidate the final signatures or protocol terms. A marker-valid fill spending a different token carrier is Core-valid but protocol-invalid.                                                                                                       |
| Invalid transactions, fees and ownership             | Re-signed wrong backing/fee transactions, duplicate markers, wrong ticker, malformed amounts, missing recipient/change, wrong scripts and excessive miner fees are rejected. `validateFinalTransaction` rejects a Core-valid recipient redirection against the original quote. Allocations follow raw carrier scripts rather than caller-supplied wallet claims.                                                                                                           |
| Competitors and both cancellation races              | Two Bitcoin-valid buyers compete for the same listed outpoint. Confirmation leaves one winner. Cancellation spends the exact carrier in one transfer, with no market or creator fee; cancel-first and fill-first both reject the losing double spend. An off-chain unavailable status leaves the allocation intact and cancellation pending.                                                                                                                               |
| Replay, conservation and reorg                       | Every confirmed step verifies wallet atoms + inventory + burned atoms = issued atoms. Replay from empty protocol state reproduces balances, vault and offers. Duplicate blocks are idempotent, changed-content duplicates and transaction replay fail, and rollback restores the prior state. Core invalidates a cancellation block; a competing fill replaces it at the same height and changes the indexed winner.                                                       |
| Transaction counts from chain data                   | The main lifecycle broadcasts 15 confirmed-at-the-time protocol transactions; after the replacement reorg the canonical history contains exactly 14. Listing, fill and cancellation each contribute one transaction. The independent mint test adds exactly three confirmed transactions. Assertions inspect Core's fetched block transaction lists, excluding coinbase.                                                                                                   |
| Browser-safe reusable functions                      | `browser.test.ts` bundles the public API for the browser and executes amount parsing, curve calculation, external native/Taproot offer verification in actual Chromium without Node globals or polyfills. The production browser artifact handles WASM; downstream consumers use ordinary package imports. `hash.test.ts` independently checks SHA256 and RIPEMD160 vectors. Production imports use `.js` module paths suitable for TypeScript consumers.                  |
| Isolation                                            | The authoritative source and isolated test support remain under this directory. The nested package has one runtime dependency and no workspace runtime edges. Root workspace and lockfile explicitly include it; parent test collection excludes the nested package; no application UI or production adapter is changed. Core datadirs and Vite cache remain isolated; SQLite is read-only.                                                                                |

`market-settlement.test.ts` adds eight regressions for the Astra review findings. Its Docker Core suite confirms purchases at expiry and two blocks after expiry; the latter remains in the mempool while explicit empty blocks advance the chain and cancellation is pending. The seller receives exactly 13,347 sats and the buyer receives all listed atoms. New construction rejects missing/invalid heights, expired offers and unavailable statuses. Fresh owner signatures confirm full transfers, partial transfers, an expired one-atom self-transfer, a combined spend of two listed carriers and a curve sale. Every resulting offer is retired, allocations match replay without off-chain offers, old fills lose as double spends, and rollback/reapplication restores the transfer state. Every confirmed regression transaction passes the SQLite wire/input/output compliance checker. The retained `tdd-market-settlement-red.log` records all eight failing tests before the fixes.

`funding.test.ts` exercises all eight builders with ordinary funding and annotated carriers (atoms-only, deployment-only, and both). The three additional Core regressions in `market-settlement.test.ts` prove that ledger-aware preflight rejects a Bitcoin-valid spend concealing token funding before broadcast; explicit consolidation instead confirms with all atoms preserved; a correctly re-signed `SIGHASH_ALL` authorization is rejected by offer verification/registration/construction while remaining valid to the generic verifier; and a valid `0x83` offer still confirms with only the buyer signing. All Core confirmation helpers now perform ledger-aware preflight before broadcast. New valid transactions continue to pass the SQLite JSON/input/output compliance checker, and all 1,950 archive comparisons remain unchanged. `tdd-funding-presign-red.log` retains the ten expected failures before implementation.

## Archive identity and compatibility limits

The activity archive contains one deploy, 812 mints and 1,137 transfers. The parent archive contains 3,409 parent transactions and 5,190 prevouts. Their SHA256 digests at verification time are:

```text
activity-2026-09-30.sqlite
fb187dab8efd4d7fa9e3751951830074e3886e1ae966855e903f874c96770e2b
parent-prevouts.sqlite
7d3717330c5bbbbabcda2aa192536c477b294cd24cb0066ae9e8571f06ff0cd3
```

All 159 BTC-funded mints pin marker vout 0, a 330-sat carrier at vout 1 and the reported BTC payment at vout 2. Exactly 743 transfers use 1,000-sat recipient carriers. All transfers have the reported recipient after the marker. Eight ORDI-funded mints instead report the beneficiary at output 2, after the payment output; no universal Garden mint-recipient rule is claimed.

The archive cannot prove Garden's issuance algorithm, ownership/change rules, fees, reserve accounting, marketplace signatures, cancellation behavior, validator acceptance or compatibility with Cove-issued assets. The ledger and signature checks establish the isolated Cove rules for native P2WPKH scripts. They do not establish existing-app integration, Taproot covenant enforcement or Guardian support; see `README.md` for the caller and replay boundaries.

## Added small-trade and compliance checks

`tdd-small-curve-red.log` records three failing tests under the old 1,000-token restriction before the curve update. The isolated implementation now supports 100-token increments, retaining the same staircase prices, cap and whole-1,000-token fee vectors, while prorating the 10-sat-per-1,000 fee upward to integer sats. `tdd-compliance-red.log` records nine failing tests before adding the SQLite checker.

The small-trade Core suite confirms 13 transactions across two independent deployments: 500 + 500 mint buys; either 400 + 600 sales or one 1,000 sale; then 500 + 500 reserve buys. Each step independently pins backing, creator/platform fees, actual fee scripts and values, miner fee, every raw input/output, inventory, issued supply and wallet allocations. The 600 and 1,000 sells combine two token inputs, adding real-chain multiple-input coverage. The first curve stair and a stair-crossing small buy have independent rounding vectors.

Both regtest suites run the SQLite compliance checker on every confirmed transaction, including the original orphan cancellation and replacement fill: 18 original transactions and 13 small-trade transactions. The machine-readable reports enumerate every input/output and state the shared rules that passed and the deliberate differences from archived Garden examples. They do not assert matching Garden fee policy, scripts, reserve accounting or ledger acceptance. All nine compliance tests pass, including corruption cases for missing prevouts, duplicate inputs, changed value/script and marker bytes.

| Small trade              | Backing paid/released | Platform fee | Creator fee |
| ------------------------ | --------------------: | -----------: | ----------: |
| First buy of 500         |               14 sats |   5,007 sats |    546 sats |
| Second buy of 500        |               13 sats |   5,006 sats |    546 sats |
| Sell 400                 |               10 sats |   1,000 sats |           0 |
| Sell remaining 600       |               17 sats |   1,000 sats |           0 |
| Alternatively sell 1,000 |               27 sats |   1,000 sats |           0 |

A 1,000-sat miner fee is checked separately on each actual transaction. Small-sale wallet top-ups are independently pinned at 2,990 sats for the 400 sale, 983 for the remaining 600 sale, and 973 for the full 1,000 sale. Token-carrier recovery and token change explain the different funding amounts.

## Shared-core target and script extension (2026-10-02)

`target.test.ts` pins canonical network/deployment identities, the existing
small-curve economics, arbitrary listing atoms, proven nested script
classification, builder funding gates, and refusal to prepare listings for
unsupported reusable-offer sellers. The native offer restriction is an open
integration requirement, not the final target wallet support.

`scripts.test.ts` independently signs nested SegWit, Taproot key-path and
Guardian execution-path inputs using bitcoinjs-lib digests. Docker Bitcoin Core
accepts and mines each path; independently retrieved raw transactions and actual
prevouts verify against the core with exactly 1,000-sat miner fees. Tampering
with prevouts, payouts, revealed commitments, execution scripts, control blocks,
parity, annexes and signature flags is rejected. Mixed-input digest comparisons
exercise DEFAULT, ALL and valid current-Taproot SINGLE|ANYONECANPAY cases, with
and without the BIP342 extension. Nested replay uses raw proven redeem data,
not caller annotations, and rollback restores the empty ledger.

Custody registration tests bind the NUMS key, Guardian key, asset commitment and
independently configured recovery-leaf hash. They do not validate selection of a
production recovery profile or prove production Guardian integration. Invalid
controller points fail before registration. Native-only reusable offers,
wallet-supported bound-message signing, production custody enforcement and
broken-vault transitions remain open Beads requirements.

Fresh Astra review found and drove fixes for unproved P2SH classification,
invalid Guardian controller points and listing preparation exceeding reusable
offer support. Its separate 126-case bitcoinjs comparison found no Taproot digest
mismatch. This is correctness evidence for the core extension, not an actual
wallet or deployment gate.

The offer extension selects one BIP322 simple authorization scheme for native
P2WPKH and BIP86 Taproot owners. `wallet-offers.test.ts` builds independent
bitcoinjs virtual transactions/signatures, rejects changed terms, noncanonical
witness vectors and incorrect seller flags, and proves message preflight before
prompts. A mined fractional Taproot listing fills with only Bob signing and
exact fee/allocation/rollback checks. Randomized Schnorr-proof retries preserve
the existing authorization and cancellation status; changed valid terms conflict.
Fresh Astra independently checked ten published valid BIP322 vectors and fifteen
malformed rejection vectors, found the retry issue and confirmed its fix.

Taproot vault selection now requires validated custody metadata. Registration
rejects missing metadata, native/key-path substitution, invalid controller points
and changed recovery branch hashes. `guardianConfig` is the mandatory selection
contract for production adapters; native vaults remain testable core script
fixtures. Actual production custody enforcement and invalid-spend/broken-vault
transitions still require their downstream integration tasks. No consumer is
connected to this core yet. Actual extension signing capability is recorded below.

## Independent package milestone

`tdd-package-red.log` records three initial failures: absent package manifest, publicly exported private-key helpers, and private-key signing in the runtime source graph. `tdd-browser-package-red.log` records the downstream consumer failing to resolve the missing built browser export. Private-key signing moved into unexported test support; pure external signing requests and verification remain in the same authoritative core.

`package.test.ts` checks the explicit nested workspace entry, exports, one runtime dependency, acyclic runtime source graph, no infrastructure or test-support imports, built Node behavior and rejected private subpaths. `browser.test.ts` uses an ordinary package-name import through esbuild with no consumer WASM plugin, serves it over HTTP, and loads it in real Chromium. Native and BIP86 Taproot BIP322 proofs plus seller witnesses verify; changed price rejects; bigint amounts above JavaScript’s safe-integer range survive and Node globals are absent. This proves production bundle execution, not actual wallet-provider behavior.

Fresh Astra review found no confirmed package bug. Independent direct-browser ESM import verified 32 bitcoinjs-signed offers across 16 keys and native/Taproot scripts, and rejected all 32 altered expiries. Node package entry and rejected private subpaths passed; a standalone strict NodeNext declaration consumer passed with no Node ambient types and `skipLibCheck: false`. Parent-package tests collect only `src`, preventing duplicated nested Docker lifecycles; its 81 unit tests pass (six existing environment-dependent integration tests remain skipped).

## Actual desktop wallet milestone

An unmodified official Xverse 2.9.3 extension in isolated headed Chromium generated both native and BIP86 offer BIP322 proofs and seller 0x83 signatures. Actual native, nested and Taproot buyer ALL responses retain finalized seller witnesses and produce exact core purchase transactions with 1,000-sat fees. A separate synthetic Guardian execution fixture retains its four-item finalized witness during actual wallet ALL signing. `wallet-evidence.test.ts` replays actual PSBTs and cryptographic checks; `wallet-key.test.ts` proves x-only normalization binds the actual owner script. The wallet was fresh and unfunded; keys were never exported and broadcasting was disabled.

Actual Cancel returns JSON-RPC -32000. Fresh wallet_getNetwork distinguishes Signet/Regtest; the test probe refuses signing while mismatched. Production adapters, mobile and live-chain behavior remain separate gates. See [capability matrix](../../../docs/CRC_WALLET_CAPABILITIES.md) for exact artifacts and limitations.

## DTO and external signing adapter milestone

The core passes 121 tests and the 1,950 read-only SQLite comparisons. Twelve adapter tests include real Chromium execution, exact native/nested/Taproot captured requests and transaction bytes, public-key mismatch, protected prevout/witness rejection, actual cancellation framing, and network changes between prompts. An additional actual Xverse response signs a core-built mint plan with a known-test Guardian execution fixture and nested wallet ALL input, preserving its finalized witness and 1,000-sat fee. Full workspace TypeScript/lint and package builds pass. Fresh Astra independently rebuilt the mint plan from source inputs and confirmed the final transaction, signatures and fee without trusting saved proof flags.

`tdd-dto-red.log` and adapter evidence logs record pre-implementation failures. `baseline-partial-signature-red.log` replays the corrected fixture against the prior wire implementation to establish missing witness/partial-signature API coverage; the initial fixture incorrectly used the restricted BIP322 decoder and was corrected. No production consumer or state reset is included in this milestone.

## Confirmed transitions and durable undo milestone

Confirmed-policy tests cover non-protocol carrier burns and offer retirement, broken vault circulation and inventory burn, missing/inconsistent parent retry, authenticated ordinary parent proofs, unsupported consensus-valid signature policy, multiple exact registered configs, intra-block fractional transfers, late paid fills after off-chain expiry/cancellation, bounded delta undo and JSON restart. An isolated Docker Core deployment and mint are followed by a mined ordinary carrier spend; production replay burns exactly its atoms, and rollback restores the prior ledger. Existing strict replay behavior remains covered by the full baseline suite.

Fresh Astra found and reproduced incorrect ordinary-parent classification and orphan offers after rollback. Failing regressions precede their fixes. Invalid funded observations now require authenticated raw parents before permanent classification, and rollback removes orphan actionable offers. Astra independently reran all 12 initial confirmed tests, including the Docker burn, and found no remaining blocker; the additional late-fill test passes separately. The full suite passes 133 tests plus that additional test, with all 1,950 SQLite comparisons preserved. Production persistence and deep-reorg checkpoint orchestration remain downstream integration work.

## Inventory-first protocol TDD (2026-10-03)

Beads epic `covedao-og4` records the test-first plan and its economics, replay,
Core journey and release-gate tasks. The four `tdd-inventory-*-red.log` files
retain failing runs before implementing unified purchase amounts, mixed replay,
the exact Core journey, and final quoted-receipt binding.

`inventory-first.test.ts` pins independent rounding, fee, inventory and cap
vectors, one-carrier construction, DTO round trips and invalid funding/state.
`inventory-first-replay.test.ts` independently signs raw transactions and checks
full receipt versus newly issued supply, signature and fee tampering, Guardian
preflight, stale inputs, replay, rollback and misleading quote annotations.

`inventory-first-chain.test.ts` uses two wallets on private Docker Bitcoin Core.
It confirms buy 400 → sell 400 → buy 1,000, subsequent 100-token and mixed buys,
full sales and successive inventory purchases. It separately confirms listing
300 from 400 with 100 change and buyer-only fill signing. Competing mixed
purchases have one winner; invalidating its block allows the other purchase to
replace it at the same height. Every accepted transaction checks fetched inputs
and outputs, exact miner fees, backing and supply conservation, and the SQLite
wire compliance checker. The JSON evidence records those confirmed transactions.

The archive verifies wire shapes and observed outputs; it does not prove the
combined issuance policy. These protocol changes do not deploy consumer support
or establish an actual extension signing gate for mixed purchases.

The final package check covers build, all 173 tests, strict TypeScript, ESLint and
formatting. `inventory-first-release-gates.log`, `verification.log`,
`typecheck.log`, `lint.log` and `format.log` retain the results. The existing
`transaction-view.test.ts` required formatting only to satisfy the package gate.
Fresh independent correctness review found no actionable findings in the mixed
purchase accounting, signed validation or replay changes.
