# CRC endpoint latency audit

Beads audit `covedao-27e`, following the deployed [submission optimization](../submit-latency/fix/README.md).

Buy and sell use the same `submitCrcSession` implementation and Guardian service. Launch, transfer, listing, purchase, and cancellation also use that submission implementation. All benefit from the shared scheduler change and removal of redundant fresh-submit RPC calls. Only curve buys and sells request Guardian custody signatures.

## Live observations

`live-probes.json` records 38 successful HTTP observations: 19 requests against localhost and the same 19 through the user's existing tunnel. Both inventory-only buy100 and mixed buy1000 quotes, sell100 using the actual token owner address, and funding exclusion returned HTTP200. These are individual observations, not load-test percentiles or latency guarantees.

| Endpoint group | Local observed time | Tunnel observed time | External calls during request |
| --- | --- | --- | --- |
| Status, trading/market availability, fees | 6.8–15.3 ms | 106.6–156.6 ms | None |
| Token catalog/detail, activity, candles, token market/UTXOs, balances, listings | 6.2–11.1 ms | 101.7–166.9 ms | None |
| Buy/sell quotes and funding-check | 12.4–16.4 ms | 116.4–142.9 ms | None |
| Wallet BTC UTXOs, first local observation | 1,861.6 ms | — | Esplora address lookup, plus tip height when needed |
| Wallet BTC UTXOs, immediate local repeat | 16.8 ms | — | Cache hit |
| Wallet BTC UTXOs through tunnel after local lookup | — | 116.3–131.2 ms | Requests within the five-second address cache TTL |

The wallet lookup returned29UTXOs. Its external lookup has a ten-second deadline and a five-second successful-result cache; concurrent lookups for the same address coalesce. It does not call Core once per returned coin. Upstream failures return retryable503 rather than a false empty balance. The tunnel wallet observations are warm and do not measure uncached Esplora latency.

Probes preserve asset state and history. Quotes/funding-check do not create sessions; wallet UTXO reads update the existing ordinary funding snapshot. No user transaction was signed, submitted, or replayed.

## Build and submit source audit

`crc-build.ts`, `crc-trade-build-route.ts`, and launch/market build callers construct plans using database state, cached funding, stored fee observations, and protocol validation. Builds do not make external Bitcoin RPC calls. Live input checks remain in submit.

For successful fresh submissions with an initialized indexed tip and N transaction inputs, the web service makes two network/canonical/input passes plus mempool acceptance and broadcast: `2N + 6` RPC calls. Curve buy/sell Guardian verification additionally makes `2N + P + 3` calls, where P is the number of distinct archived deployment parents. This includes network verification, deployment proof, and input/canonical checks immediately before and after custody signing.

| Operation | Shared submit path | Guardian custody | Example fresh RPC count |
| --- | --- | --- | --- |
| Launch | Yes | No | 8 with one input |
| Buy, including inventory and mixed issuance | Yes | Yes | 18 with two inputs and one deployment parent |
| Sell | Yes | Yes | 22 with three inputs and one deployment parent |
| Transfer/listing/purchase/cancel | Yes | No | 10 with two inputs; additional inputs add two calls each |
| Publish seller's signed offer | Separate `activateCrcCoreOffer` | No | 3: network, canonical cursor, listed input |

Counts are source-derived, except the three-input sell measured by the existing controlled regression. Funding choices can increase N. Known-transaction retries use network/transaction observation and saved bytes; fresh-submit counts do not describe recovery or failed validation.

The previous controlled sell measurement was34.252seconds before versus8.591seconds after with modeled200ms RPC transport at the actual shared3requests/second cap. It proves that case, not identical duration for all operations or live Xverse requests. No live signed-submit timing is claimed by this audit.

Marketplace `crcMarketPost` directly calls `submitCrcSession`, so it receives the runtime improvements, but does not forward `onTiming` or emit the `Server-Timing` header added to launch/buy/sell routes. Follow-up `covedao-fli` tracks matching diagnostic headers and focused route tests. No further repeated RPC pass was found in offer publication or the read/build endpoints.

All17owned Core/PostgreSQL/HTTP Guardian integration tests passed on rerun; `integration.log` records the88.84second suite. It covers launch, issuance/inventory/mixed buy, sell, arbitrary transfer, listing, buyer-only fill, cancellation/reorg, spent-input rejection, and persisted receipt recovery. Runtime source and deployment are unchanged by this audit.
