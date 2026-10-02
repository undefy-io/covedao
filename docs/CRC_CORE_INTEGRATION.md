# Shared CRC core integration contract

The target is `packages/cove-market/crc20-protocol`, with the frontend from
`5dded6a`. Consumers must call this core for amounts, markers, curve, fees,
output order, allocations, signed offers and ledger transitions. Adapters own
HTTP, database transactions, Bitcoin RPC, PSBT serialization and wallet calls.
This is a fresh replacement: no protocol profiles, historical asset routing,
backfill, or parallel implementation. Work status and gates live in Beads epic
`covedao-ag3`, not in this document.

## Identity and economics

The canonical core networks are `bitcoin`, `signet`, `testnet`, and `regtest`.
An adapter normalizes the API/wallet name `mainnet` to `bitcoin`; it must never
merge signet and testnet merely because their address prefixes match.
Registration identity is network plus lowercase 32-byte deployment txid.
Ticker and marker bytes alone cannot register an asset. Only trusted,
Cove-created registrations enter replay; external Garden deployments are ignored.
`deploymentIdentity` only formats validated identity, not registration authority.

The existing economics remain authoritative: 100-token execution quantum,
100,000,000 atoms per token, 1,000-token price/per-lot fee unit, 1,000-sat
carrier/vault anchor, 7,000-sat launch fee, 20,000-sat maximum miner fee.
Transfers/listings accept arbitrary positive atoms. The existing fee policy,
small-sale wallet top-ups and exact reusable seller authorization remain in force.
No adapter may recreate fee, change, or supply arithmetic.

## Wallet scripts and signatures

The frontend resolves separate payment and ordinals accounts. Required support
includes native P2WPKH, nested P2SH-P2WPKH funding, Taproot key-path token/funding
inputs, and the Guardian's Taproot execution path. A P2SH address does not prove
its redeem script; a Taproot address does not prove its execution path.

A reusable seller authorization requires input 0 / output 0 and exactly
`SINGLE|ANYONECANPAY` (`0x83`). Buyers sign their own funding with `ALL`; already
finalized seller and Guardian witnesses must survive PSBT processing.
Bound offer terms use the core's canonical message and BIP322 simple proof for
native P2WPKH or BIP86 Taproot owners. The raw-key helper now produces that same
proof and remains test capability evidence only. Actual Xverse desktop 2.9.3 proves serialized-witness base64 framing, native/compressed and BIP86/x-only public keys, and required script signing/preservation. `canonicalOfferPublicKey` proves the script before signing. No consumer receives raw wallet private keys.

Signet is the proposed live canary chain. Actual desktop signing capability is measured using unfunded synthetic prevouts with broadcast disabled; see [wallet evidence](CRC_WALLET_CAPABILITIES.md). Mobile and live-chain execution remain **unverified**. These signing proofs do not close later transaction/release gates. Mainnet is not activated, and no real funded user-wallet spend is authorized by implementation work.

## Custody and broken vaults

Retain a Guardian-controlled Taproot execution leaf with the configured recovery
branch. Do not replace it with a single native wallet key to fit the isolated
core. The trusted registration must bind the actual vault script, Guardian key,
asset commitment, and recovery profile. The core must verify the execution
witness and its commitment to the actual prevout; adapters retrieve actual
prevouts and independently trusted registrations, never backend quote metadata.
Taproot vault configurations require validated custody metadata; production
adapters select `guardianConfig` and independently validate the configured
recovery profile. Guardian re-evaluates the same core transition before signing
and journals spends.

This remains custodial enforcement: Bitcoin checks the configured signature and
script, while the Guardian applies the token/curve rules. It is not a consensus
token covenant. Recovery/controller misuse can break the backing vault.
A confirmed invalid/non-protocol vault spend makes curve actions unavailable;
circulating tokens remain transferable/marketable under their own valid carrier
rules, without a redemption guarantee. Invalid/non-protocol carrier spends burn
the allocation and retire its offers. Never leave phantom spendable balances.
A retrieval failure is not proof of a burn or vault loss. Production transition,
undo and persistence proofs belong to `ag3.5` and `ag3.6`.

## Consumer replacement map

| Current source | Replacement / retained responsibility |
| --- | --- |
| `packages/protocol/src/crc20.ts` | Replace CRC wire/parser decisions with core; retain unrelated shared protocol exports. |
| `packages/crc20-transactions/src` | Remove duplicated transaction/funding policy after core PSBT adapter proof. Keep SQLite reference fixtures read-only. |
| `packages/crc20-ledger/src` | Remove CRC ownership/replay decisions; core transitions are the ledger authority. |
| `packages/cove-market/src/crc20` | Remove market rules/browser verification/store decisions; core offers/plans plus DB adapter. |
| `packages/cove-indexer/src/crc20` | Replace parser/replay/registration decisions; retain chain retrieval, atomic persistence and worker scheduling as adapters. |
| `apps/worker/src/crc*` | Core replay/persistence adapter; retain RPC budgets, health and shared worker infrastructure. |
| `apps/web/src/lib/crc*` | Core DTO/quote/plan/PSBT/wallet adapters; retain HTTP/auth/idempotency/rate-limit responsibilities. |
| `apps/web/src/components/Crc*`, routes, shared components and CSS | Preserve components, layout, styling, routes and controls; replace internals/hooks only. |
| `apps/web/src/components/WalletProvider.tsx`, `src/lib/wallets` | Preserve wallet picker/session UX; validate core plans and supported signing requests before prompts. |
| `packages/cove-vault/src/crc20-vault.ts` | Vault construction/custody adapter; core verifies selected script and commitment. Preserve shared recovery infrastructure. |
| CRC signing in standalone `/home/andefy/dev/guardian` | Import identical core; independently load state/prevouts and authorize exact plan. Preserve user README edits. |
| `packages/db/drizzle/0027*` through CRC tables and later CRC migrations | Fresh CRC schema/state reset after replacement proof. Retain shared authentication/RPC/funding/non-CRC tables. |
| `scripts/research` and CRC SQLite archives | Retain read-only wire evidence; do not use Garden ledger observations as Cove economics. |

Inventory imports before deletion; the table describes ownership, not permission
to delete shared modules wholesale. V3 infrastructure that CRC currently imports
must be assessed per symbol. Never reintroduce old CRC behavior as a fallback.

## UI preservation evidence

`git diff 5dded6a -- apps/web/src/components apps/web/src/app` was empty before
integration changes. Browser captures under
`artifacts/crc-core-integration/ui-baseline/` record the existing local signet
web UI at 1440×1000 and 390×844 for launch, token, market, and disconnected
wallet. They are read-only captures of the pre-replacement running image, not
proof of new-core integration or a source-built visual parity test.
Additional full-page launch review and buy review captures include fee presets
and connect controls. `manifest.json` records routes, viewport dimensions, image
hashes and the immutable runtime image ID. Runtime build provenance has not been
proved against the source commit. Connected wallet captures additionally show 1,000 TOKEN1 using a simulated
read-only provider and mocked balance/empty-UTXO responses. Signing and mutation
requests are disabled; this is appearance evidence only. Seller listing, buyer
fill and cancellation reviews remain for the browser release harness. All
replacement comparisons remain open.

Preserved interaction contracts include launch metadata fields and review,
buy/sell tabs and amount inputs, fee presets, sell shortcuts, charts/history,
market filters and listing controls, wallet holdings/transfer/cancel controls,
wallet picker, rejection/disconnect/network handling, and pending refresh.
Amounts/fees may change only to accurately display the target core values;
control structure and appearance remain the baseline.
