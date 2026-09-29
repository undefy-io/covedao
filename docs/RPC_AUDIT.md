# RPC audit — 2026-09-29

Fresh source audit of application commit `f17e3cd` and standalone Guardian
commit `a0aa8f2`. Task: `covedao-853`. This inventories current call paths;
it does not claim that the follow-up findings have been fixed.

## Public endpoint inventory

There are 36 V3 route files exposing **37 handlers**: **22 use the database or
local computation**, **14 can call Bitcoin Core**, and **one uses an address
index on signet/mainnet or Core on regtest**. The development wallet adds two
handlers, disabled in production.

Paths below omit `/api/v3`. “Core” means a reachable call on the normal valid
path, not that every invocation calls Core: guards, existing submissions and
invalid parameters can return earlier. A `rpcOperation` wrapper alone does not
mean the enclosed operation calls RPC.

| Method | Path | Data source / external call |
| --- | --- | --- |
| GET | `/status` | DB runtime, cursor and observation epochs |
| GET | `/fees` | DB worker fee observation; no RPC fallback |
| GET | `/tokens` | DB |
| GET | `/tokens/sparklines` | DB |
| GET | `/tokens/[tokenId]` | DB |
| GET | `/tokens/[tokenId]/activity` | DB |
| GET | `/tokens/[tokenId]/candles` | DB |
| GET | `/tokens/[tokenId]/holders` | DB |
| GET | `/tokens/[tokenId]/market` | DB |
| GET | `/activity` | DB |
| GET | `/wallet/[address]/portfolio` | DB token portfolio, not the BTC UTXO index |
| GET | `/tx/[txid]` | DB snapshot; unknown IDs do not enroll RPC polling |
| GET | `/market/listings` | DB |
| GET | `/market/fills/[fillId]` | DB allowlisted public fill status |
| POST | `/backing/buy/quote` | DB validated pending backing observation |
| POST | `/backing/buy/quote-sats` | DB validated pending backing observation |
| POST | `/backing/redeem/quote` | DB validated pending backing observation |
| POST | `/tokens/[tokenId]/buy/routes` | DB confirmed supply and listings; pricing finding below |
| POST | `/launch/prepare` | Local token identity / launch terms |
| POST | `/market/listings/[listingId]/cancel/prepare` | Local signed-message payload |
| POST | `/market/listings/[listingId]/reserve/prepare` | Local signed-message payload |
| POST | `/market/listings/[listingId]/cancel` | Signature validation and DB writes; no Core |
| GET | `/wallet/utxos` | Signet/mainnet: cached, budgeted Esplora address UTXOs and tip height. Regtest: Core `scantxoutset` |
| POST | `/launch/build` | Core health/quorum/network and funding `gettxout`; optional ord asset checks |
| POST | `/launch/submit` | Core network/acceptance/broadcast and uncertain-result observation |
| POST | `/backing/buy/build` | Core health, pending backing, funding and independent transition validation; optional ord |
| POST | `/backing/buy/submit` | Core pending backing, funding and broadcast; mainnet also remote Guardian HTTP with its own Core checks |
| POST | `/backing/redeem/build` | Core health, pending backing and funding/transition validation; optional ord |
| POST | `/backing/redeem/submit` | Core pending backing, funding and broadcast; mainnet also remote Guardian HTTP |
| POST | `/transfer/build` | Core health and BTC funding; DB token input selection |
| POST | `/transfer/submit` | Core network/acceptance/broadcast and uncertain-result observation |
| POST | `/market/listings/prepare` | Core source `gettxout`; pending split fallback also `getrawtransaction` |
| POST | `/market/listings` | Core health and source validation |
| POST | `/market/listings/[listingId]/reserve` | DB authorization preflight, Core funding/source/health and `getblockcount` |
| POST | `/market/fills/[fillId]/build` | Core market health and source check; DB fees |
| POST | `/market/fills/[fillId]/buyer-signature` | Local signature/DB checks followed by finalize and Core broadcast |
| POST | `/market/fills/[fillId]/finalize` | Core app health, market health, network/acceptance/broadcast |

`/api/dev/wallet` GET/POST only reach `scantxoutset` for balance/UTXO actions
when all development/regtest opt-in guards pass. Signing itself is local. The
live production image returns 403 for this route.

Main call-path evidence:

- `apps/web/src/app/api/**/route.ts`: complete handler enumeration.
- `packages/cove-app/src/service.ts`: read methods at 420; quote observation at
  445; live pending ancestry at 525; listing preparation at 2194; fill finalize
  at 2388.
- `packages/cove-market/src/service.ts`: source checks at 228/270, listing PSBT
  preparation at 487, reserve at 585, fill build at 700 and finalize at 887.
- `apps/web/src/app/api/v3/wallet/utxos/route.ts` and
  `packages/bitcoin/src/address-cache.ts`: address-index path.

## Core methods and transport controls

Runtime Core calls are `getblockchaininfo`, `getblockhash`, `getblock`,
`getblockheader`, `getblockcount`, `getrawmempool`, `gettxspendingprevout`,
`getmempoolentry`, `getrawtransaction`, `gettxout`, `estimatesmartfee`,
`getmempoolinfo`, `testmempoolaccept` and `sendrawtransaction`.
Regtest wallet discovery adds `scantxoutset`.

The central `CoreRpcProvider.call` acquires the PostgreSQL account budget on
each attempt, including retries. Core calls have a 30-second total call
deadline, a 20-second fetch deadline and a 9 MB response limit. Read 429
responses can retry three times, bounded by the deadline; broadcasting disables
automatic retry. Most RPC-capable routes and worker tasks have an enclosing
180-second Core deadline. This deadline does not currently encompass every
external dependency; see `covedao-ox1`.

Configured allowance defaults to three requests/second for hosted networks.
The budget reserves lanes for public requests, worker and Guardian; at that
setting the public lane starts approximately one request/second. A valid
multi-call transaction can therefore take seconds even when individual gateway
responses are fast. Per-call counts multiply with funding inputs, ancestry,
competition and optional secondary-node checks.

All deployed V3 provider constructors attach a budget. App, worker and
Guardian must use the **same quota database and provider account identity** to
coordinate a shared gateway allowance. A Guardian using another state DB can
set `COVE_RPC_BUDGET_DATABASE_URL` to the shared quota DB. API-key identity is
shared across URLs; Basic/no-auth identity includes origin and credentials.
Rate/concurrency configuration must agree across these services.

## Worker and indexer

Intervals are sleeps **after** task completion, not guaranteed request rates.
Loops run concurrently but share the worker RPC lane.

| Task | Schedule | Chain requests |
| --- | --- | --- |
| Indexing | Per-network `workerPollMs` (signet 5 seconds) | One `getblockchaininfo` on a quiet tip. Cursor hash check when behind; new blocks use `getblockhash`, raw `getblock`, `getblockheader`. Reorg recovery checks ancestors |
| Pending projections | 1 second after completion | One `getrawmempool` and final `getblockchaininfo`; supported nodes also batch `gettxspendingprevout`. Additional bounded proof/head `gettxout` and uncached ancestor `getrawtransaction` calls |
| Fees | 60 seconds after completion | Three target `estimatesmartfee` calls plus `getmempoolinfo` |
| Market observations | 5 seconds after completion | Bounded listing source `gettxout` and transaction membership/raw observation as needed; tip supplied from DB |
| Reservation expiry | 5 seconds | DB |
| App session reconciliation | 5 seconds | DB canonical confirmation |
| Canonical submission conflicts | 5 seconds | DB indexed spend evidence |
| Saved submission recovery | 60 seconds; up to two jobs | Live checks, acceptance/broadcast/uncertain-result observation for unfinished jobs |
| Quota cleanup | 60 seconds | DB |

Confirmed block indexing is already tied to tip movement. Pending transaction
membership, accepted backing branches and relay fees can change without a new
block. These observations therefore still poll; caching them for a full block
interval would make accepted competing transactions and evictions invisible.

The worker remembers an unsupported spender method and filters fallback
candidates using the current mempool snapshot. Proof work is bounded to two
new `gettxout` reads per refresh. Positive canonical proofs can be reused until
indexed spending/reorg evidence invalidates them. Failure/unavailable proof
does not become tradable state. This bounds load but does not mean every token
is immediately warm after startup.

## Guardian, address index and other HTTP

- Standalone Guardian `/sign`: authenticated, two concurrent sign operations
  per process, Core account budget, live tip/cursor/network/UTXO/pending ancestry
  verification and independent funding validation. It must keep these checks.
- Guardian `/health`: custody key plus audit/journal DB probes; **no Core RPC**.
  Startup checks Core network once. App/worker profile agreement contacts
  Guardian health; it is an HTTP call, not Bitcoin RPC.
- Signet currently uses the in-process local signer. Mainnet requires the
  remote Guardian and incurs its independent Core/ord calls.
- Esplora address UTXO discovery has a separate account budget, bounded
  address-cache capacity/inflight work, generation fences, bounded bodies and a
  ten-second request deadline. Cache misses remain external chain reads.
- Mainnet ord asset lookup uses an aliased `doFetch`, not `fetch(` directly:
  `packages/cove-guardian/src/v3/funding.ts:201`. App and Guardian both use it.
  It currently has only a five-second per-request timeout; follow-up below.
- `EsploraChainProvider`, manual index/verify/readiness commands, lifecycle
  proofs, canary and recovery tools can make unbudgeted calls. They are not
  installed as background services in the running signet compose. Running
  them against the same hosted account adds traffic outside runtime quotas.
- Legacy `start:v1` and `PrecopCRCAdapter` are not the deployed worker/web
  entrypoints. `pnpm start` in the worker launches `src/v3.ts`.
- Local regtest compose has direct Bitcoin CLI health/mining/funding/tool
  calls, appropriate to the bundled local node. Its worker health probe also
  contains a direct fetch bypass; signet already uses the DB-only probe.

## Findings recorded in Beads

| Issue | Priority | Evidence / impact |
| --- | --- | --- |
| `covedao-ir7` | P1 | Missing fill IDs and invalid build inputs can reach `requireHealthy`/`assertMarketReady` before cheap validation, consuming public RPC capacity without a valid transaction |
| `covedao-6kx` | P1 | App live pending fallback probes unsupported spender RPC repeatedly and checks up to 64 old competitors individually; unlike the worker it has no batch membership filtering |
| `covedao-4uk` | P1 | Buy-route comparison reads confirmed supply rather than the validated accepted pending state; missing backing defaults to zero supply and invents a route |
| `covedao-h6b` | P2 | Equal-height health unnecessarily reads block hash; fill finalize repeats app/market health, quorum repeats primary tip and mainnet genesis is reread per mutation |
| `covedao-ox1` | P2 | Ord requests lack shared budget/body bounds and enclosing cancellation; remote Guardian HTTP uses a separate timeout |
| `covedao-xt2` | P3 | Local regtest worker health bypasses shared Core budget; scan queue/retries lack a total lifetime bound |

These are follow-up issues, not evidence that live funding/signature checks
should be removed. No transaction validation changes were made during the audit.

## Verification and limits

- 104 targeted tests passed: Bitcoin provider/Esplora/recorded broadcast (61),
  application funding/readiness/token reads/runtime snapshots/fees/tx status
  (43). Existing tests cover timeout/retry handling and key DB-only read paths.
- Live web and worker were healthy and used image
  `sha256:db1674a42395cc928e146b4cfca4f0771e730f64bf5cf351e274a09af183ba08`.
  Worker image source hashes matched checkout for app service, Core provider,
  worker entrypoint and DB-only health probe. No source mounts were present.
- Initial status sample: indexed/Core height 324149, zero lag. Later
  read-only inspection showed generation 5 at height 324151.
- 20 sequential localhost probes are saved in
  `scripts/testing/rpc-read-audit-results.json`. DB read samples took 3–20 ms;
  the address-index lookup took 1899 ms. These are single samples, not load or
  Cloudflare tunnel latency measurements.
- A budgeted, read-only gateway capability probe confirmed that
  `gettxspendingprevout` is still unsupported on the configured signet provider.
- Initial backing quotes failed closed with retryable 503 because fresh
  validated observations were unavailable. The indexed generation changed
  during the audit; this is consistent with the refresh gate. After fresh
  observations were available, buy and budget quotes returned 200; the tiny
  redeem request returned a validation 400. The initial failures are preserved
  in the results rather than hidden by later successful samples.
- Source tracing establishes RPC reachability. HTTP timing alone cannot prove
  zero RPC calls. This audit did not broadcast, sign or create transactions,
  modify chain/DB state, restart services or run a new mutation load test.
