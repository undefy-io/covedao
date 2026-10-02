# Shared-core API evidence

The API uses `@crclaunch/crc20-protocol` through signing and persistence adapters. Existing UI components, layouts, styles, routes and controls are unchanged. Browser internals, full UI-to-chain verification, obsolete CRC deletion/reset, and the authorized live-wallet canary remain subsequent epic tasks.

## Verification

Owned disposable PostgreSQL and Bitcoin Core 30.0 containers exercise HTTP route handlers and an actual HTTP Guardian service. The API tests mine deployment, mint, sell, inventory buy, a one-atom arbitrary transfer, a one-transaction listing, buyer-only presigned purchase, and cancellation. Every signed transaction uses core plan verification and actual node-derived prevouts. Tests assert exact fees, allocations, offer status, registration before broadcast, idempotent receipts, and zero-RPC construction.

`mined-api.json` records 14 successful broadcasts (including cancellation rebroadcast after an actual reorg), raw signed transactions, actual prevouts and stored core plans/configs. Keys and coins belong to the isolated regtest fixtures. These transactions do not involve user wallets or real funds.

The reorg test invalidates the cancellation block and clears only its owned node's orphan mempool. Indexer rollback restores the allocation/open offer and deletes orphan activity; API retry revalidates and rebroadcasts the persisted receipt. An already signed paid fill remains valid after advisory offer expiry, while a new expired build is refused. Competing advisory builds are allowed; the spent vault is rejected before a second custody call.

Fresh state is stored in `crc_records`, `crc_events`, `crc_metadata` and `crc_sessions`. Core-generated events supply API activity/trade facts; consumers do not reinterpret transactions. Funding uses confirmed server observations and excludes every indexed token allocation and vault, with bounded exact-outpoint and vault-txid queries. The fresh migration includes the matching partial index. No old CRC data is converted or read by these API services.

## Recovery regressions

Fresh Astra reviews found three availability failures; each has failing and passing regression evidence:

- A lost Guardian response followed by a newly signed wallet retry received a cached whole PSBT containing the original wallet signature. The API now validates that response, copies only its vault witness into the current verified wallet PSBT, and validates the combined transaction. Wallet witness/scriptSig bytes remain current; custody signs once.
- An expired API signing lease accepted only the original signature hash. A fresh core-verified response can now acquire a new claim UUID after expiry. Live leases and stale completion/release fences remain enforced.
- Build retries consulted refreshed funding/state before retrieving their saved response. All builders now validate stable request identity and replay persisted bytes first. Launch/trade HTTP routes retain the original selected fee rate for that request. Changed requests conflict; new requests use current observations. The HTTP sell regression consumes its token inputs, clears funding and changes rates from 2 to 5 sat/vB before proving exact replay with zero RPC.

A separate regression ensures core trade-quantum refusal is reported as a client amount error before funding construction. It does not change the core's 100-token execution quantum.

## Gates and limits

Core: 144 tests, including all 1,950 read-only SQLite transaction comparisons. Adapters: 18 tests, including real Chromium and captured actual Xverse native/nested/Taproot signing responses. Indexer: 89 passed, one unrelated environment skip. Guardian: five owned integration tests. Workspace typecheck, lint and build pass; the final web run and build logs accompany this evidence.

Standalone Guardian receives 39 hash-checked canonical runtime/schema/migration files. Install, Rust/build, typecheck, lint, tests (30 passed; 14 existing environment skips), and Docker packaged ESM imports pass. The preexisting user README edit is preserved. Neither repository is deployed by this milestone; CRC application state is not reset and mainnet is not enabled.
