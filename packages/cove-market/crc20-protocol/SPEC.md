# CRC protocol: user stories and tests

## Two token actions

After launch, every token movement is a **mint** or a **transfer**.

- Mint marker: `{"p":"crc-20","op":"mint","tick":"TEST"}`. It contains no amount. Cove derives the minted amount from its registered curve, the previous vault state, the successor vault, and BTC payment in the same transaction.
- Transfer marker: `{"p":"crc-20","op":"transfer","tick":"TEST","amt":"50000000000"}`. `amt` is the atom amount sent to the spendable output immediately after the marker. Sending to a friend, selling into the curve, buying existing reserve tokens, and marketplace purchases all use transfer.

Launch is setup: its marker has fields `p,op,tick,type,max,lim,leaf,ordi,btc` in that order. It registers the curve, fee rules, vault, and asset identity `(network, deploy txid)`. A ticker alone cannot identify an asset.

These wire shapes come from the read-only Garden archive `../../../artifacts/crc-garden/activity-2026-09-30.sqlite`. All 812 archived mint markers omit the amount; all 1,137 transfer markers contain `amt` and have the recipient output immediately after the marker. The archive does not disclose Garden's issuance formula or ownership rule. Cove's rules below are explicit Cove choices.

The Cove curve trades in **1,000-token lots**. Wallet transfers and market
listings can use any positive integer number of atoms. A 500-token market
listing is valid; a 500-token curve buy or sell is rejected by this curve.

## What users can do

### Alice buys 2,000 TEST

Alice enters **2,000 TEST**. The UI quotes the BTC cost, creator and protocol fees, estimated miner fee, token-carrier sats, and total before she signs. One transaction spends the current vault output and her BTC funding, writes the amountless **mint** marker, puts a 2,000-TEST carrier immediately after it, and creates the successor vault plus fee and BTC change outputs. The indexer derives exactly 2,000 TEST from the Cove curve transition and credits Alice. It rejects the mint if the payment, outputs, or derivation disagree. Bob can buy separately and receives only his own tokens.

### Alice sends 500 TEST to Bob

Alice owns a Bitcoin output carrying 2,000 TEST. She enters 500 TEST and Bob's address. One transaction spends that output. Its **transfer** marker has `amt=50000000000` because TEST has 100,000,000 atoms per displayed token. The next output carries 500 TEST to Bob; another carries 1,500 TEST back to Alice. BTC change is separate. The indexer removes the spent 2,000-TEST allocation, credits both new outputs, and leaves issued supply unchanged.

### Alice sells 1,000 TEST into the curve

After sending 500 of her 2,000 TEST to Bob, Alice owns 1,500 TEST. She sells
**1,000 TEST**, one curve lot. The UI shows gross backing released, protocol
fee, any wallet top-up needed for a spendable payout, miner fee, and her net
economic result before she signs. One transaction spends Alice's token output
and the current vault output. A **transfer** marker sends 1,000 TEST into the
successor vault. The transaction pays Alice BTC and returns 500 TEST to her.
Reserve inventory rises by 1,000 TEST, circulating supply falls by 1,000
TEST, and issued supply stays the same. A 500-TEST curve sale is rejected.

### Bob buys 1,000 previously sold TEST

One transaction spends the vault and Bob's BTC funding. A **transfer** marker
sends 1,000 TEST from reserve inventory to Bob and creates a successor vault.
Inventory falls, circulation rises, and issued supply does not rise. A
purchase that spans inventory and new issuance is rejected with a request to
split into an inventory buy and a mint; it cannot be guessed from the marker.

### Alice lists 500 TEST for 12,347 sats; Bob buys it

A listing records the deploy txid, 500 TEST, 12,347 sats **total**, Alice's payout script, expiry, and network. **Listing is one on-chain transaction.** It spends Alice's 2,000-TEST output and uses a normal **transfer** marker to create an exact 500-TEST sale output controlled by Alice, plus a 1,500-TEST change output controlled by Alice. It also fixes the sale output's outpoint. Alice authorizes sale of only that outpoint at the stated price as part of the listing flow. No third on-chain preparation or split transaction is allowed.

**Buying is one on-chain transaction.** It spends that sale output and Bob's BTC funding together. It pays Alice the agreed sats, writes a **transfer** marker for 500 TEST, puts Bob's carrier immediately after the marker, pays declared fees, and returns BTC change. The validator checks the spent outpoint, asset, amount, seller payout, fees, recipient, and signatures before crediting Bob. If a competing buyer or Alice's cancellation spends the outpoint first, the other transaction loses as a Bitcoin double spend. Bob must not pay without receiving a valid token allocation in the same accepted transaction.

Alice may list any amount she owns in the one listing transaction, which creates an exact carrier and returns her remainder. A buyer cannot partially fill an already signed listing; doing that requires a separate residual authorization protocol.

### Alice cancels before Bob buys

Alice can request cancellation while the listing is open. The service marks
the signed offer unavailable immediately, but **on-chain cancellation is one
transfer transaction** that spends the exact listed output back to a new
output owned by Alice. That spend invalidates any presigned fill by making
its token input unavailable. Alice pays the cancellation miner fee; there is
no marketplace fee because no sale occurred. If Bob's fill confirms first,
Alice's cancellation fails as a double spend and Bob receives the tokens.
If cancellation confirms first, Bob's fill fails and Alice keeps the tokens.
The UI must show pending cancellation as pending until chain confirmation;
an off-chain status change alone is not a Bitcoin-level cancellation.

## Fee rules and who pays

These are the existing Cove v3 fee rules, not claims about Garden fees. All
calculations use integer satoshis; `ceil(x)` rounds up to the next satoshi.

| Action | BTC accounting |
| --- | --- |
| Launch | Creator funds the deploy outputs, **7,000-sat launch fee**, and miner fee. The deploy quote must list each output. |
| Curve mint or reserve buy | `gross = backing(after) - backing(before)`. Protocol fee is `5,000 + 10 × lots + ceil(7.5% × gross)` sats. Creator fee is `max(ceil(50% × gross), 546)` sats. Buyer funds gross + both fees, token-carrier output, and miner fee; any already funded input/output value is accounted for once. The vault retains the full gross backing. |
| Curve sell | `gross = backing(before) - backing(after)`. Protocol fee is `max(ceil(7.5% × gross), 1,000)` sats. Economic result before miner fee is `gross - protocol fee`. If the spendable BTC payout must be topped up to dust, the quote shows that extra wallet funding and the actual payout separately. No creator fee is charged on sell. |
| Wallet transfer or listing | No creator or marketplace fee. Sender funds any new carrier outputs and the miner fee, less BTC recovered from spent inputs. Token change and BTC change are separate. |
| Market buy | Seller receives the listed **price** as economic proceeds and recovers the sats locked in the listed carrier. Protocol fee is `max(ceil(7.5% × price), 1,000)` sats; for a 12,347-sat listing it is **1,000 sats**. Buyer funds the price, protocol fee, buyer-carrier sats, and miner fee, less BTC from buyer inputs. No creator fee is charged. The quote distinguishes price, fee, carrier sats, and miner fee. |
| Cancel | Alice pays only the miner fee and any needed carrier funding after accounting for the listed output's sats. There is no market or creator fee. |

Every signed transaction must satisfy `sum(inputs) = sum(outputs) + miner fee`.
Fee outputs must use the scripts registered by the Cove deployment. The
current funding policy caps the miner fee at 20,000 sats. Fees must be checked
again against the final transaction, not only against the quote.

## Cases and edge cases to test first

1. **Garden evidence:** recompute txids from SQLite raw hex; assert marker bytes, field order, output order, BTC values, and recipient for deploy `546cc042d0f396a0d8ad67b6987d9d5c09619e6962738347ca1611a1d1841b67`, BTC mint `17c4c6fa3a877aa42c142f4836c3cb6b10d4e588ff2150df842e2e3e3e89bde4`, sale `532f22d0edcd848d28b81ddb6b089402860d01fda2ec1fdb9701ea13bb0a2dcd`, and custom 500-TEST sale `c4a840c7c4bbe0f8cce6a03cb71664be7e6b7c730f4e1e1f89d52f973a822118`. Check applicable marker and recipient rules across all 1,950 archived transactions. The Garden mint amount remains unresolved from the marker alone.
2. **Amounts:** zero, negative, fractional, exponent notation, greater than balance, one atom, 123,456,789 atoms, exact full balance, and values above JavaScript's safe integer range. Use `bigint` and canonical decimal strings.
3. **Mint:** correct 2,000-TEST quote and payment; wrong payment; wrong fee or recipient; stale vault; cap; ambiguous issuance; duplicate marker; a different wallet trying to claim the output.
4. **Transfer:** 500 of 2,000 with exact 1,500 change; full balance; multiple token inputs; wrong asset or ticker; missing token input or change; BTC change mistaken for token change; missing or unspendable recipient.
5. **Curve sale and inventory buy:** exact 1,000-token lot payout, protocol fee, wallet top-up, miner fee, 500-token remainder, insufficient vault BTC, too-small economic result, stale vault, and buying sold inventory without increasing issued supply. Reject 500-token curve trades and a buy that crosses inventory into new issuance.
6. **Marketplace:** exactly one confirmed listing transaction creates 500-TEST sale output plus 1,500-TEST change from Alice's 2,000 TEST; exactly one purchase transaction spends that sale output and pays Alice 12,347 sats plus returned carrier sats. Assert the 1,000-sat protocol fee and separate buyer carrier/miner costs. Repeat with arbitrary atom amounts and integer-sat prices. Test altered amount, buyer, payout, or fee after signing; two buyers racing; and marker-valid but wrong token outpoint. Assert that a Bitcoin-valid transaction can still be protocol-invalid.
7. **Cancellation:** signed off-chain cancel without an on-chain spend does not count as final; one confirmed self-transfer of the listed output cancels it on-chain with miner fee but no market fee; fill-first and cancel-first races have one winner and exact balances.
8. **Fees and replay:** independently pin launch, buy, sell, listing, fill, and cancel fee vectors; reject missing/wrong fee outputs and miner fee over the cap. After every confirmed transaction, wallet allocations plus reserve inventory plus burned atoms equal issued atoms. Replay raw blocks from empty state, repeat a block, and reorg a block; balances and vault state must be deterministic.

## Test and implementation order

Create an empty test file first. Write the SQLite compatibility tests and story/edge-case tests **before** implementation; record a failing run. Use independent expected curve and fee values, not values obtained by calling the code under test. Run positive stories using two distinct Bitcoin Core wallets on private local regtest: check mempool acceptance, broadcast, mine, fetch raw transactions and prevouts, then replay through the package's public API. Missing Core fails the test prerequisite.

Implement only inside this folder: browser-safe amount and wire functions, Cove rules and pure quotes, transaction builders, listing validation, and deterministic replay. Core RPC and SQLite helpers are test-only. The frontend, backend, and indexer can later import the same public functions. Passing these tests establishes Cove behavior and Garden-shaped wire format; it does not prove Garden's unpublished ledger rules.
