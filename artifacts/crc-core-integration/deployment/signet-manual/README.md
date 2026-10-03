# Local Signet manual testing

The user explicitly authorized replacing the previous local deployment and selected Signet with an actual wallet extension. The new production frontend is running at **http://localhost:3000**, with aligned CRC worker and standalone Guardian. All services use a fresh `cove_crc_fresh` database and the same local test profile, with activation height 324722 (the observed Signet tip at deployment).

[evidence.json](evidence.json) records actual image IDs, source parity, public Guardian health and the initial empty catalog/core root. Web and Guardian Docker health and the real CRC worker readiness probe pass. All 21 actual CRC runtime files match. Four bootstrap tests, all 204 web tests, web typecheck/lint and the actual fresh production image build pass. Bootstrap is repeated successfully and is idempotent; it initializes empty core state and never resets an existing matching ledger. Fresh Astra final recheck found no remaining actionable issues.

## Manual steps

1. Open http://localhost:3000 and refresh any previously open tab.
2. Set Xverse to **Signet**, then use **CONNECT**. The test browser intentionally has no wallet extension installed; [wallet-picker.png](wallet-picker.png) confirms the actual production connection controls.
3. Use **LAUNCH** to create a token, review the transaction, and sign with your test wallet. The initial catalog is empty. You need Signet test BTC for transaction funding.
4. After confirmation/indexing, use the token page for mint/sell and the wallet/market controls for transfer, listing, purchase and cancellation. For a buyer-only market fill, connect the second account after the seller publishes the offer.

No user-wallet transaction was signed or broadcast during deployment. The actual-extension and funded two-account canary remains open for manual completion; deployment health does not prove those signatures.

## Operations

Secrets and the selected profile remain in gitignored `.env.signet.local` and `.local/signet-crc-profile.toml`. From the repository root:

```sh
docker compose --env-file .env.signet.local -f docker-compose.signet.yml ps
docker compose --env-file .env.signet.local -f docker-compose.signet.yml logs --tail 50 worker guardian web
docker compose --env-file .env.signet.local -f docker-compose.signet.yml up -d --wait worker guardian web
```

Committed startup order is migration, explicit bootstrap, then worker/Guardian and web. The bootstrap command refuses mainnet. The previous service containers were replaced; the previous Signet database is inactive. Temporary regtest preparation services were stopped. Mainnet and user funds were untouched. This Signet stack is intentionally left running for manual testing.

Manual testing subsequently exposed an external address-index timeout. The deployed
[wallet-index recovery fix](../wallet-index-recovery/README.md) preserves observations
and returns a retryable 503 for upstream failures; the exact reported tunnel wallet
request is verified HTTP 200 after redeployment.

The latest frontend also uses Xverse's modern permission-granting connection API.
[Pre-prompt permission evidence](../xverse-permissions/README.md) records the corrected
access-denied/cancellation handling. Actual reconnect and popup recovery remain
pending manual verification; refresh and reconnect Xverse before retrying a launch.
