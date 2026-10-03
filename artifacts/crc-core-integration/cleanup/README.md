# CRC replacement cleanup and reset

Milestone `covedao-ag3.11` removes the four obsolete CRC packages, old market/parser implementations, V3 product API and page selection, unused frontend hooks/components, old wallet/status routing, and obsolete product tests and executable probes. Shared non-CRC libraries and historical result artifacts remain. Captured JSON research fixtures move under `artifacts/crc-garden/derived-fixtures`; the three SQLite databases retain their recorded hashes.

Migration `0041_crc_fresh_reset` drops all 14 superseded `cove_crc_*` tables and explicitly clears the 12 current `crc_*` tables. There is no data conversion or backfill. Its snapshot preserves all 66 retained table definitions and links to 0040. A real isolated PostgreSQL test first failed because old tables remained, then proved fresh bootstrap, reset to empty, unchanged shared state and exact core reinitialization. The Drizzle generator failed on BigInt serialization, so the removal snapshot was derived and checked explicitly.

The default worker and product API now use CRC. Its readiness file is scoped by database identity/network, written after ownership acquisition and refreshed only after successful Core/database sync. The probe rejects failures, wrong networks, dead processes and observations older than three polling intervals. Public regtest development settings coordinate web/worker/standalone Guardian. Fresh host/CI/image startup builds the core and adapters before import; Docker context excludes nested TypeScript incremental caches. Old V3 web E2E is replaced by the owned CRC gate.

## Verified gates

- Core: 147 passing tests, including all 1,950 read-only SQLite raw-transaction comparisons.
- Wallet adapters: 19 passing tests, including captured actual Xverse native/nested/Taproot responses.
- Web: 200 passing tests, including owned HTTP/Core and PostgreSQL checks.
- Workspace: 94 combined build/typecheck/lint/test tasks pass; serial production build passes 26 tasks.
- Standalone Guardian: 41 managed files byte-checked, install/Rust/build/typecheck/lint pass; 30 tests pass and 14 existing environment-dependent tests skip. The preexisting user README edit retains its SHA-256.
- Desktop/mobile browser: 48 checks pass, including 14 exact baseline `5dded6a` pixel/control comparisons, 32 interactions and two loaded-script audits. The previous milestone's retained screenshots show the unchanged interface. An initial Chrome response-body/dev-tool timing failure is recorded; warm rerun passes all assertions unchanged.
- Fresh production app Docker image builds successfully: `sha256:7f9ff152faa20c1ed7a2fe1cb3cafef5a0c7867ba1ab3575da55ea130fdf0465`. Initial failures and the final successful build are retained.
- Default browser-to-chain E2E: seven scenarios pass using owned production web, actual Docker Core/PostgreSQL, independent Guardian and real confirmed indexer. Evidence contains 17 unique mined transactions, 18 raw/core/database comparisons, 28 wallet prompts and nine custody signatures. All expected core roots match persisted roots. The 146 copied app source hashes identify the tested production copy.

`logs/*-red.log` preserve failing-before-change evidence. Final gate logs and `chain-evidence.json` record passing execution. Fresh Astra review findings in runtime/CI entrypoints, heartbeat scoping and clean-checkout build prerequisites were fixed and rechecked.

These tests simulate wallet callbacks with public regtest keys. They do not prove a funded actual-extension spend, enable mainnet, or reset an existing deployed environment. Fresh coordinated deployment and the separately authorized actual-wallet canary remain task `.12`.
