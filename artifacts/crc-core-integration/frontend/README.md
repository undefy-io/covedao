# Shared-core frontend evidence

The existing CRC UI from `5dded6a` retains its components, layout, styles, routes and controls. Browser internals reconstruct reviewed operations with `@crclaunch/crc20-protocol`, verify server PSBTs before prompts, and complete wallet responses with shared adapters. No wallet private key reaches browser code.

## Browser gates

The final Playwright run passes **48/48** desktop/mobile checks: 14 pixel/control comparisons across seven existing routes, 32 interaction checks, and two active-script audits. `ui-parity.json` records byte-identical current/baseline screenshot SHA-256 values; both images from every comparison are included. The audit inspects scripts actually loaded on all seven pages and rejects obsolete CRC math and server/database modules.

Interactions cover launch metadata/7,000-sat fee review, 500-token buys, 400/600-token sells, exact network fees and carrier-credit movement, Guardian input 0 left unsigned, buyer-only fills retaining the seller's 0x83 witness, seller BIP322/0x83 publication and ALL cancellation. Altered PSBTs, unsupported prevout scripts, wallet rejection, changed launch description/links/images and disguised token funding never reach submission. Disconnects during independent observations prevent prompts; disconnects while a wallet response is pending prevent submission. Busy controls recover after refusal.

The browser transport and provider are explicitly simulated. Signing keys stay in the Node test process behind an exposed callback; injected browser wallet metadata contains public keys only. These tests prove component/service/signing behavior, not mined browser-to-chain execution or a live extension spend. The next dependent E2E task provides owned Core/PostgreSQL/indexer/Guardian integration.

## Correctness and regression gates

Core **147/147** tests pass, including **1,950** exact read-only SQLite wire comparisons and owned Docker Core lifecycles. The three new transaction-view tests preserve normal full-ledger conservation and reject changed selected atoms, scripts and BTC values. Browser view validation returns no ledger for persistence.

Adapters **18/18** pass, including real Chromium completion of captured actual Xverse native/nested/Taproot responses. Web **232 passed, eight existing unrelated environment skips**, including 13 owned HTTP/Core/Guardian integration cases and six owned PostgreSQL read tests. Workspace typecheck/lint/build pass. Standalone Guardian install, Rust/build, typecheck/lint and tests pass (**30 passed; 14 existing environment skips**), with 39 byte-checked managed files and the user's README hash preserved.

`astra-review.md` records two fresh scoped Astra correctness reviews and the failing/passing fixes. Final review reports no remaining confirmed blockers in the frontend scope. Regression logs named `*-red.log` intentionally retain failing-before-change evidence; `*-green.log` and final gate logs retain passing-after-change evidence.

To rerun the browser gates, start this checkout and a detached `5dded6a` checkout with `COVE_PROTOCOL_MODE=crc20`, `COVE_NETWORK=regtest`, telemetry disabled and isolated dummy database URLs. Set `CRC_CORE_UI_URL` and `CRC_CORE_BASELINE_URL` (defaults 3118/3119), then run `pnpm --filter @crclaunch/web test:e2e:crc-core`. API calls are intercepted by the owned fixtures. No existing application server or database is reused.

This milestone does not deploy the replacement, reset application state, enable mainnet or spend user funds. Full mined UI-to-chain E2E and obsolete-code/state removal remain separate dependent gates. Live-wallet/mainnet execution requires later explicit authorization.

The sell increment hint uses the authoritative core's 100-token execution quantum; the existing default amount and 1,000-token pricing unit remain.
