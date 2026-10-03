# Browser RPC migration

Implemented the reviewed Beads plan `covedao-2y8` and Guardian child `covedao-1dz` on 2026-10-03. A fresh GPT-6.1 Sol reviewer approved the corrected plan before implementation and reviewed the resulting trust boundaries. Its findings about ordinary-only review, queue deadlines, Retry-After and failure precedence were fixed and covered by regressions.

Wallet discovery uses browser Esplora; immutable funding parents and ordinary funding review use the same public Bitcoin RPC. Explicit build configuration is `NEXT_PUBLIC_COVE_BITCOIN_RPC_URL=https://bitcoin-signet-rpc.publicnode.com` and `NEXT_PUBLIC_COVE_ESPLORA_URL=https://mempool.space/signet/api`. All three shared-image compose build definitions pass the same public arguments. Server credentials are not copied into public configuration. Rebuild Next when changing these variables.

| Path | Result |
| --- | --- |
| Wallet getters; launch/buy/sell funding; market buyer/cancel funding; seller coin preview | Shared browser discovery, bounded/coalesced requests and immutable parent cache |
| Launch, trade, transfer/listing, purchase/cancel builds | Optional version1 request-scoped parent evidence, hash/output/script derivation and current DB carrier/vault exclusion; no global snapshot writes |
| Pre-wallet review | Current confirmed ordinary funding checked directly with `gettxout(...,true)`; indexed token/vault review retained |
| Provider availability failure | Restart funding selection from exact payment/ordinal server observations and omit the entire evidence envelope |
| Wrong network, malformed/hash-mismatched data, spent/unconfirmed input, user abort | Reject; no availability fallback |
| Submit and Guardian | Trusted live confirmation/unspent, canonical, signature and custody checks retained; only verified immutable deployment parents cached |
| Quotes, token balances, activity, offers and indexed status | Remain authoritative backend/indexer projections |

Evidence has exactly `{version:1,network,parents:[{txid,rawHex}]}`. Maximum40 distinct candidate parents and200000 aggregate hexadecimal characters; the existing transport limits remain. Evidence covers request candidates even when the final builder uses fewer inputs. Ordered candidate outpoints retain the previous idempotency hash; immutable evidence is validated before replay, mutable exclusions after replay misses. Missing evidence supports older clients and regtest. Raw transaction declared counts are checked against remaining bytes before allocating arrays; protocol encoding/economics are unchanged.

Browser requests have at most4 active fetches, deadlines including queue time, bounded response bodies, short address/identity observations and bounded immutable parent caches. Retry-After seconds/dates are honored; delays beyond the deadline cause availability fallback. Joined consumers have independent cancellation. Batch semantic failures take priority over availability failures so an outage cannot hide invalid evidence.

Verification:

- Workspace typecheck/lint:45 tasks each; workspace tests:44 tasks. Web254 tests and protocol174 tests pass, including all1950 Garden SQLite transactions and archived output/input parity.
- Owned Core/PostgreSQL/HTTP Guardian suite:17 tests pass, with proof-backed launch/buy/sell/transfer/listing/purchase/cancel and inventory/mixed flows, consumed funding replay, old session plus new evidence, malformed proof rejection, READY recovery, competitors and reorgs. Evidence-backed builds work without wallet funding snapshots.
- Real Chromium desktop/mobile direct-mode caller fixture: ordinary funding only, zero backend wallet discovery, one coalesced parent fetch across trade/purchase review.
- Shared Guardian7 tests; standalone Guardian install/typecheck/lint and30 tests pass (14 existing skipped).
- `production-stack.json`: actual rebuilt regtest app/standalone Guardian lifecycle, buy400/sell400/buy1000/repeat100, restart preservation,23 shared runtime hashes and52 desktop/mobile UI tests, including comparison with the previous regtest image. All owned test containers/networks were removed.
- `build-attestation.json`:40 app runtime sources/23 Guardian sources verified against current source; both public URLs are present in actual production browser chunks.
- `public-browser-probe.json`: real read-only Chromium Signet discovery found30 coins, obtained/verified one parent proof and current input observation directly through the public providers;6 total public requests and0backend address-discovery calls. No wallet signatures or broadcasts.
- `signet-before.json` and `signet-after.json`: identical digests for11 sessions (4BUILT/7BROADCAST),1registration,7events and25ledger records. Live database/profile were backed up; services restarted without migration/bootstrap/reset. Old images retained in `rollback.json`. Local and tunnel readiness succeed.

The application's existing default3/s backend scheduler was not changed. This is not the actual public provider quota, which remains unspecified; separate Beads follow-ups cover quota scoping and backend read/worker scaling. The user's unrelated standalone Guardian README remains untouched.
