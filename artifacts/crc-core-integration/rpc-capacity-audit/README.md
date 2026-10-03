# Endpoint capacity and browser offload audit

Beads audit `covedao-4l7`. This covers every current web API method, including the supported operations behind the marketplace dispatcher:25static handlers expanded to35method/path combinations. The companion JSON records source files, external calls, response caching, admission and recommended placement. The previous endpoint latency observations are in [the latency audit](../endpoint-latency/README.md).

## Corrected quota interpretation

The selected deployment uses `https://bitcoin-signet-rpc.publicnode.com` for Bitcoin RPC and, absent an override, `https://mempool.space/signet/api` for wallet address lookup. These are different upstream services. `COVE_RPC_REQUESTS_PER_SECOND` is unset in the running web/worker environments, so the application defaults to3/s. That is an application setting, **not PublicNode's documented or user-provided limit**. The user explicitly corrected that their provider is not limited to3/s; its actual sustained/burst quota remains unspecified in this audit. Do not use the earlier ten-buys/minute calculation as a provider capacity claim.

Web, worker and standalone Guardian coordinate grants in PostgreSQL when their budget database and `providerAccount` identity match. The current identity uses API key when present, otherwise origin/user/password. That coordinates this deployment, but is not a faithful general representation of an IP quota: different credentials or endpoint origins can create independent buckets even when the provider charges them to the same egress IP. Conversely, an API key is grouped across origins even where provider policies might be separate. Scaling needs an explicit configured quota scope tied to the provider policy. Sharing an IP with unrelated applications also consumes quota outside our scheduler.

The same numeric setting currently controls the wallet Esplora budget. Separate provider limits are required. Existing budget JSON rejects changing rate/concurrency against a live old row; a quota adjustment requires a coordinated, tested transition across web/worker/Guardian. Compose uses `env_file`, so setting the variable in that file is supported. No live rate change occurred during this audit.

## Every web endpoint

All CRC rows below are relative to `/api/crc/v1`; dev wallet rows retain their full path. N is transaction input count; P is the number of distinct archived deployment parents. Counts describe valid fresh transactions with an initialized indexed tip; retries, upstream429retries and failed validation have different counts. `read` and `wallet` are process-local CRC admission groups; `none` means no route-level CRC admission in the current handler, not that the ingress has been audited.

| Method | Endpoint | External requests | Server response cache | Admission |
| --- | --- | --- | --- | --- |
| GET | `/activity` | none | none | read |
| POST | `/backing/buy/build` | none | none | wallet |
| POST | `/backing/buy/quote` | none | none | none |
| POST | `/backing/buy/submit` | fresh web2N+6; buy/sell Guardian2N+P+3 additional; recovery separate | none | wallet |
| POST | `/backing/sell/build` | none | none | wallet |
| POST | `/backing/sell/quote` | none | none | none |
| POST | `/backing/sell/submit` | fresh web2N+6; buy/sell Guardian2N+P+3 additional; recovery separate | none | wallet |
| GET | `/fees` | none | process5s coalesced | read |
| POST | `/launch/build` | none | none | wallet |
| POST | `/launch/submit` | fresh web2N+6; buy/sell Guardian2N+P+3 additional; recovery separate | none | wallet |
| GET | `/market/listings` | none | none | read |
| POST | `/market/listings` | Core3 | none | wallet |
| POST | `/market/seller-requests` | none | none | wallet |
| POST | `/market/funding-check` | none | none | wallet |
| POST | `/market/reserve` | none | none | wallet |
| POST | `/market/cancel-build` | none | none | wallet |
| POST | `/market/transfer-build` | none | none | wallet |
| POST | `/market/listing-build` | none | none | wallet |
| POST | `/market/buyer-sign` | fresh web2N+6; buy/sell Guardian2N+P+3 additional; recovery separate | none | wallet |
| POST | `/market/cancel` | fresh web2N+6; buy/sell Guardian2N+P+3 additional; recovery separate | none | wallet |
| POST | `/market/transfer-submit` | fresh web2N+6; buy/sell Guardian2N+P+3 additional; recovery separate | none | wallet |
| POST | `/market/listing-submit` | fresh web2N+6; buy/sell Guardian2N+P+3 additional; recovery separate | none | wallet |
| GET | `/market/status` | none | none | none |
| GET | `/status` | none | none | none |
| GET | `/tokens/[assetId]/activity` | none | none | read |
| GET | `/tokens/[assetId]/candles` | none | none | read |
| GET | `/tokens/[assetId]/market` | none | none | none |
| GET | `/tokens/[assetId]` | none | none | none |
| GET | `/tokens/[assetId]/utxos` | none | none | none |
| GET | `/tokens` | none | none | none |
| GET | `/trading/status` | none | none | none |
| GET | `/wallet/[address]/balances` | none | none | none |
| GET | `/wallet/utxos` | Esplora1address+optional1tip; regtest scan | process5s address/height + same-address coalescing | wallet |
| GET | `/api/dev/wallet` | regtest scan for GET without identity or POST getUtxos; production403 | none | generic |
| POST | `/api/dev/wallet` | regtest scan for GET without identity or POST getUtxos; production403 | none | generic |


Builds persist an advisory draft/session and operate on indexed data, cached funding and database fee observations. They do not resolve each input through Core. The comment in `WalletProvider.getUtxos` claiming Core resolution at build time is outdated: the current non-regtest route uses Esplora and live Core validation happens during submit.

Publication of a seller's signed offer is separate from an on-chain listing transaction: its3RPC checks cover network, canonical indexed hash and listed input. `seller-requests` validates a script and returns an empty array; it is a compatibility read, not another signing workflow. Unknown market operations return404. Marketplace is currently gated to Signet/regtest testing; this report does not imply mainnet marketplace release.

The dev wallet refuses production requests with403before any Core call. In permitted regtest development, GET without an identity and POST getUtxos use a coalesced `scantxoutset`; GET identity, POST signPsbt and POST signBip322 operate locally. It is irrelevant to public production RPC capacity.

Authenticated Guardian `POST /sign/crc20` performs the additional curve-signing calls listed above; this is an internal endpoint with private authorization. It admits at most two concurrent signatures per process. Guardian `GET /health` probes custody/audit/journal locally and through the database; it does not add Bitcoin RPC calls in this implementation. The separate legacy `POST /sign` transport is not the CRC path and must not be exposed to browsers. Browser code must never receive Guardian authentication or private RPC credentials.

## What can move into the browser

Wallet discovery can use browser fetches against the network's public Esplora address/UTXO endpoint. Raw transactions can also be fetched by the browser and sent as bounded evidence. The backend can compute the expected transaction hash, decode outputs, derive amounts/scripts, verify signatures and reconstruct protocol transitions locally. CRC balances, token ownership, current vault state and offers still come from our indexer/database: a generic Bitcoin RPC does not know Cove's ledger.

A safe funding evidence contract accepts bounded outpoints and raw parent bytes, verifies transaction identity and output index, matches the connected wallet script/public key, derives amounts from bytes rather than submitted fields, and excludes indexed token/vault outputs. Client confirmation counts and unspent flags remain advisory. It must not write client hints into the shared table as if they were server observations. Current `loadCrcFundingCandidates` requires the server-populated `cove_wallet_funding` table; merely changing frontend fetch URLs would break builds or retain the same upstream server traffic. The build contract has to change with the browser client.

Browser review already checks core plans and wallet intent locally, but its Bitcoin input observations currently call our own wallet endpoint, sometimes for both payment and ordinals addresses. `WalletProvider`, `crc-browser-session`, market funding and seller preview/signing each have their own call paths. An offload needs one coalesced browser discovery adapter across all these callers, network-specific endpoints, bounded caching, timeouts,429backoff and a controlled server fallback. The wallet extension API must be capability-detected; the published [Sats Connect method list](https://docs.xverse.app/sats-connect/wallet-methods/request-methods) does not establish a universal wallet UTXO method across our supported adapters.

Raw parent bytes prove the content of the referenced output, not whether someone has already spent it. Confirmation/inclusion evidence also does not prove present unspent status. The backend and independent Guardian therefore retain trusted live input/canonical checks immediately before and after custody and before broadcast. [Bitcoin Core gettxout](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/gettxout/) supplies current unspent output/confirmation information and excludes mempool-spent outputs when requested. Passing a browser's gettxout JSON back to the server cannot substitute for that observation.

This means frontend discovery and immutable transaction evidence can be offloaded, but most of the18/22calls in a typical curve submission are current-state checks and do not disappear. Guardian's archived deployment parents are a concrete exception: hash-verified immutable content can be accepted/cached independently, removing P requests per fresh signing without removing live fences. A server-maintained trusted local UTXO/mempool source is another way to eliminate hosted RPC for those checks; it changes the backend data source rather than trusting client assertions.

The CORS observations in `publicnode-preflight.headers` and `esplora-cors.headers` show PublicNode accepts a content-type POST preflight and mempool's tip endpoint allows cross-origin reads, both for the existing frontend Origin. Only one OPTIONS and one read-only tip GET were made. These headers are a current feasibility observation, not a full browser wallet integration test, proof of provider reliability, or permission to exceed upstream policies. Public APIs also see each client's wallet address/IP; users behind a shared NAT still share a provider IP quota. Mempool [documents rate limits and higher-limit service options](https://mempool.space/docs/api/rest).

## Background and application capacity findings

The deployed CRC worker has `COVE_CRC_POLL_MS=1000`, overriding the15000ms source default. Every unchanged indexed tick makes getblockchaininfo and getblockhash. The interval is a delay after a tick, so2calls/second is a zero-latency upper bound, not measured consumption. Each new block adds getblockhash, getblock, getblockheader, a final canonical hash check and relevant external parent reads; intra-block parents and repeated parent IDs within a block are reused. Fee observation runs once/minute: one mempool-floor RPC on Signet, four calls on normal node estimate mode. This background traffic must be included in capacity estimates.

Even with no new block, `syncCrcTip` reloads the whole ledger rather than using the provided snapshot, because offers may publish between ticks. `loadCrcCoreLedger` reads every network record and retained undo, restores/hashes the state and takes a network advisory lock. Builds, submits and Guardian also load this state. That is a concrete scaling concern beyond the hosted RPC quota; any optimization must retain offer publication, canonical state-root and reorg correctness.

Each visible browser store polls `/status` every5seconds; hidden tabs stop, unchanged indexed height/hash avoids repeating successful subscribed projections. This is a store per JS context, not a cross-tab coordinator. At5000visible contexts, the interval alone produces roughly1000status requests/second before response delay/focus events. The current CRC status handler issues a DB cursor query for each request and has no server cache or limiter. The previous legacy status cache described in historical memories does not apply to this replacement handler.

Catalog/detail/market/token UTXOs/balances and buy/sell quotes also lack route-level CRC admission and shared response caches. Activity/candles/listings have read admission but no response coalescing. Only fees uses `PublicReadCache` at5seconds. Catalog and balances are paginated; activity, trades/candles, token UTXOs and listings have bounded result counts, but bounds do not avoid repeated work for many readers. Indexed hash is appropriate for confirmed projections, including same-height reorgs. Offer publication changes listings between blocks, so listings need a separate offer generation/invalidation mechanism. Availability flags use local release configuration; no public Core health probe is made there.

Address cache entries/coalescing are process-local,5secondTTL, with at most4active distinct lookups and1000entries. All replicas still share the Esplora budget when configured alike, but the same address on different replicas can fetch repeatedly. Each successful hit still writes the funding snapshot. At high user count, different-wallet cache misses provide little reuse; this is the strongest browser offload candidate.

CRC read admission uses60000requests/minute/process overall and1200/minute/trustedIP where applied; wallet/build/submit/marketPOST share6000/minute/process and60/minute/trustedIP. If a trusted ingress IP header is not configured, `local` bypasses per-IP counts and only totals apply. These application admission limits are independent of the upstream quota and are not shared across replicas. PostgreSQL RPC grants have bounded queues/deadlines and fairness, so overload returns failure rather than increasing throughput. Signing, per-input checks, DB locking, same-token vault competition and confirmation requirements remain throughput constraints even after increasing a configured RPC rate.

## Capacity interpretation and validation

For a configured sustained grant rate R, this scheduler spaces starts by ceil(1050/R)ms. The successful no-retry RPC ceiling is therefore approximately60*R/1.05calls/minute before background traffic. Dividing by18for a typical two-input buy or22for a three-input sell gives an RPC-only ceiling; actual provider quota, concurrency, retries, worker work, input counts, custody latency and same-vault contention reduce usable capacity. No numerical PublicNode production capacity is claimed until the actual provider limit is supplied and owned-provider workload measurements are run.

The prior17owned Core/PostgreSQL/HTTP Guardian tests and38live read/quote probes provide correctness/low-load observations, not a many-user capacity proof. This audit additionally reran16focused tests across indexed refresh, read caching, wallet lookup recovery and DB-only builds; `validation.log` records the pass. The inventory validator checks35expanded endpoint entries and coverage of all25static handlers. No stress test against public providers, deployment/rate change, database reset, user signing or replay occurred.

Follow-ups saved in Beads: `covedao-3jy` covers actual provider-specific policy/configuration; `covedao-2y8` covers browser discovery and locally verified funding evidence; `covedao-1dz` covers immutable Guardian deployment-parent proof caching; `covedao-l5t` covers public read caching/admission and background ledger/polling capacity. The existing marketplace timing-header gap remains `covedao-fli`.
