# Inventory-first consumer integration

Beads epic `covedao-8w1` tracks the protocol consumer integration. Core economics and wire operations remain authoritative. Quotes, build sessions, browser verification, server submission and Guardian preflight now agree on the full purchased receipt and its inventory/issuance breakdown. The interface retains one Buy review and signing request.

## Tested journeys

- Buy 400, sell 400, then buy 1,000: one transaction delivers 1,000, consumes 400 inventory and issues 600. Gross backing is 27 sats, protocol fee 5,013 sats and creator fee 546 sats, plus the reviewed network fee.
- Inventory purchases of 100/400 and mixed purchases of 500/1,000 choose the actual transfer/mint operation. Subsequent 100-token purchases work.
- Native, nested SegWit and Taproot payment signatures preserve full receipts through browser and server Guardian preflight.
- Forged receipt, inventory decomposition or operation is rejected before additional RPC/custody/signing. Pure older sessions without decomposition remain verifiable; mixed sessions require it.
- Activity and trades report the full receipt; decomposition is additive for mixed confirmed events. Existing candles consume that full receipt. Indexed height/hash refresh behavior is preserved.
- Confirmed mixed transactions survive persisted reload and coordinated restart. Actual invalidation and replacement blocks restore inventory, balances and indexed history.
- Partial listing and buyer-only fill transfer 300 from a larger acquired balance while preserving change and supply. Repeated purchases and market fills use independently signed Bitcoin Core transactions.
- Desktop/mobile controls sign a mixed purchase once; mined Chromium interaction shows the 1,000-token activity receipt without manual refresh.

## Evidence and reproduction

The `tdd-*-red.log` files demonstrate preimplementation failures. `adapters-all-green.log`, `quotes-green.log`, `browser-green.log`, `full-stack-green.log` and `guardian-service-green.log` record passing focused suites. `mined-consumers.json` and `mined-browser.json` include actual regtest raw transactions, reviewed intents and durable core state evidence. `production-stack.json` verifies actual independently built app/standalone Guardian images, source/schema parity, the mixed journey and restart preservation. Callback wallet signatures are simulated, with keys in the Node test process; this is not actual Xverse canary evidence.

Workspace typecheck/lint/test and standalone Guardian typecheck/lint/test logs are retained. Workspace tests include 173 protocol tests with the 1,950-row read-only SQLite corpus, 29 adapter tests, 238 web tests and 90 indexer tests. Existing unrelated skips remain recorded in their logs. Desktop/mobile interaction, activity refresh and loaded-bundle checks run separately from the historical pixel-baseline comparison, which requires a separately running baseline server.

```sh
pnpm --filter @crclaunch/crc20-adapters test
pnpm --filter @crclaunch/web exec vitest run src/lib/crc-quote.test.ts src/lib/crc-quote-route.test.ts src/lib/crc-browser-session.test.ts src/lib/crc-core-submit.integration.test.ts
pnpm --filter @crclaunch/web exec playwright test -c playwright.crc-chain.config.ts
# Serve the regtest-built production image at 3118 with an isolated dummy DB URL; all API calls below are intercepted.
pnpm --filter @crclaunch/web exec playwright test -c playwright.crc-core.config.ts interactions.spec.ts activity-refresh.spec.ts bundle.spec.ts
python3 scripts/guardian/sync-crc-core.py /home/andefy/dev/guardian --check
```

Build app images for the matching network: the browser embeds its network at build time and runtime refuses a mismatch. The owned deployment script accepts `inventoryFirst: true` and requires regtest-built app images. It creates and cleans only UUID-prefixed disposable resources; its reset test never touches selected Signet state.

## Selected Signet rollout and manual canary

The coordinated upgrade is complete. [signet-rollout.json](signet-rollout.json) records healthy services, 21 matching runtime files, unchanged ASDF state/history/registration, and the actual successful quote for 1,000 tokens with 400 inventory and 600 new issuance. Web/worker run image `29a61275`; standalone Guardian runs `d379071e`.

The authorized selected localhost Signet upgrade preserves the existing ASDF deployment, inventory, history, registrations and activation height. The pre-upgrade DB dump and profile copy are gitignored under `.local/signet-backups/inventory-first-8w1/`. Previous images are retained as `covedao-signet-app:pre-inventory-8w1` and `covedao-signet-guardian:pre-inventory-8w1`.

After the coordinated upgrade, refresh localhost:3000, reconnect Xverse on Signet, open ASDF and review a 1,000-token buy. Existing 400 inventory should be used automatically with 600 newly issued, in one transaction. Sign with your wallet, then check the confirmed 1,000 receipt and automatic activity update. A later 100-token buy and a 300-token listing/fill can be tested with funded accounts.

Read-only rollout evidence is separate from actual-extension proof. The actual Xverse/two-account canary stays open in `covedao-8w1.10` until the user performs and reports it. No user-wallet transaction is signed by the agent.

Do not downgrade to the prior mixed-unaware core after a mixed transaction enters history: it cannot interpret the upgraded state safely. Rollback must coordinate compatible web/worker/Guardian versions and a verified state/chain replay strategy; the pre-upgrade dump is recovery evidence, not permission to erase later confirmed user transactions.
