# Fresh coordinated deployment evidence

Task `covedao-ag3.12` independently verifies an owned, temporary regtest deployment. The actual-extension and funded two-account Signet canary remains unverified, so the task and epic remain open.

The executable harness starts five actual Docker containers: Bitcoin Core 30, PostgreSQL 16, production web, CRC worker, and standalone Guardian. UUID resource names, a private deployment database, loopback published ports and regtest-only credentials isolate the run. Its cleanup removes and checks only its owned containers/network, then removes its temporary Core directory. Successful evidence requires cleanup success. This run leaves no persistent deployment.

## Verified result

[evidence.json](evidence.json) records six passing checks, image IDs, raw transactions, plans, catalog/state roots and service logs:

- Committed migrations apply to a new database; obsolete CRC tables are absent and the CRC namespace starts empty.
- Explicit core empty-ledger bootstrap uses the trusted regtest profile and activation height 101. The worker indexes the actual Core tip at height 103. Confirmed registered deployments supply their own asset configuration through core replay.
- Production web is active, the real CRC worker readiness probe passes, and Guardian reports healthy audit, signing journal and custody. All 21 CRC runtime source hashes match between actual web and actual Guardian files and the managed manifest; CRC schema definitions also match.
- Coordinated service restart preserves the empty core root. With all consumers stopped, the explicit CRC reset followed by bootstrap/replay restores that exact root. Full Guardian health is checked after both recoveries.
- A fresh launch mines at height 105 with a 1,765-sat miner fee. A 500-token mint mines at height 106 with a 1,990-sat miner fee and one real Guardian journal signature. Authoritative core raw-transaction validation runs before confirmation, and the actual worker catalog reports exactly 50,000,000,000 minted atoms.

Wallet signatures use a public regtest fixture in Node. `actualExtension: false` is deliberate. Existing environments, mainnet and user funds are untouched. Shutdown messages in the service logs result from the deliberate restart/reset/cleanup exercises.

## Reproduction

From the repository root, with dependencies installed and the verified regtest app and standalone Guardian images available:

```sh
node --test scripts/testing/crc-fresh-deployment.test.mjs
node scripts/testing/crc-fresh-deployment.mjs
```

The default image tags are `covedao-crc-cleanup-regtest:ag3-11` and `covedao-crc-guardian-regtest:ag3-11`; exact image IDs are in the evidence. Fresh image build commands/logs are retained in [cleanup evidence](../cleanup/README.md). `CRC_DEPLOYMENT_EVIDENCE_PATH` selects the output JSON path. The harness creates a new environment each time and tears it down in its finalizer.

Two unit tests cover owned resource boundaries and runtime attestation failure. Archived red/green logs include initial bootstrap import, changing ephemeral ports after restart, intended shared-schema differences, and the test helper's corrected core validator call. The public fixture secret was redacted in failed command dumps; verification results are intact. The schema comparison intentionally checks the CRC suffix because shared non-CRC definitions differ between application and standalone Guardian.

## Remaining gate

The selected fresh Signet environment is now deployed; see [manual testing](signet-manual/README.md). Two actual extension accounts and separately authorized reviewed test transactions are still required for the funded manual canary, including reusable 0x83/BIP322 offer signing and buyer-only fills. Actual extension availability and transaction authorization have not been supplied. Regtest fixture signing cannot close this gate. Existing actual-wallet capability evidence is under [wallet capability provenance](../wallet-capabilities/extension-provenance.json); prior seven-scenario browser-to-chain, reorg and allocation evidence is under [chain](../chain/README.md).
