# Blockstream discovery without public wallet-data fallback

Implemented Beads `covedao-jpo` on2026-10-04. Public wallet address discovery uses Blockstream Esplora; genesis, raw funding parents, current UTXO checks, and broadcasting continue using the configured public Bitcoin RPC. Mainnet/testnet/signet Esplora and explorer defaults now use the matching Blockstream paths in app and standalone Guardian configuration. Token activity links use the committed network explorer; regtest has no external explorer link. Both example env files document the three Blockstream API bases. The deployed Signet public index is `https://blockstream.info/signet/api`.

The user's additional instruction to remove fallbacks supersedes the earlier browser-migration outage fallback. Public-network coins, evidence, and input-review failures now propagate directly without switching to backend observations. Missing browser client configuration fails without backend lookup. The backend `/api/crc/v1/wallet/utxos` endpoint returns HTTP410 on public networks before address-index/RPC/snapshot work. Regtest retains its explicit Core developer-wallet discovery; this is a configured development mode rather than a public-provider failure fallback. Broadcast recovery still queries the expected transaction on the same RPC after an ambiguous send result; it does not switch providers or relay through the backend.

Verification:

- Workspace44 test tasks and45 typecheck/lint tasks passed after the config/default change. Final web261 tests pass after fallback removal, including19 owned real-Core/DB/HTTP Guardian lifecycle tests. Final web typecheck/lint also pass.
- Focused outage/configuration/public-endpoint tests prove zero backend calls and no funding snapshot writes. The actual Xverse wallet-first fixture uses explicit direct input observation; real Chromium desktop/mobile tests cover direct review and saved transaction recovery.
- Standalone Guardian frozen install/typecheck/lint and30 tests pass, with14 existing skips. Its unrelated user-edited README is byte-for-byte preserved.
- `build-attestation.json`: deployed app/Guardian runtime sources match; actual Next browser chunks contain the Blockstream Signet API URL and zero `mempool.space` references.
- `public-browser-probe.json`: real read-only Chromium discovery found32 coins. Five public requests go only to Blockstream and the configured RPC; zero backend wallet discovery and no genesis-index request. No wallet signing or valid broadcasting was initiated.
- `live-browser.json`: desktop/mobile real token history uses Blockstream transaction links, with zero mempool.space requests. Public backend wallet discovery returns410. Local/tunnel trading readiness pass.
- `deployment.json`: all17 pre-upgrade sessions, their saved transaction bytes,9 events, registration, and profile are preserved; worker readiness passes. Web/worker/Guardian images were restarted without migration, bootstrap, or reset. Temporary backup-comparison DB was removed.

Database/profile backup: `.local/signet-backups/blockstream-jpo/`. Previous images: `covedao-blockstream-rollback:{web,worker,guardian}`. Refresh the browser to load the new provider configuration and remove the old cached client. Historical evidence and optional research-provider references are archival/tooling material, rather than production runtime dependencies.
