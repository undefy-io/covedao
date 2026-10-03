<p><img src="docs/assets/covs-logo.png" alt="covs" width="96" /></p>

# covs.trade

A Bitcoin token launchpad using the single CRC-20 core in
`packages/cove-market/crc20-protocol`. Frontend verification, API construction,
confirmed-block indexing and Guardian signing consume that core through adapters.
The application has no legacy API or protocol selector.

The interface preserves the routes, controls, layout and styling from `5dded6a`.
Core rules, fees, token allocations and JSON wire compatibility are tested against
actual Bitcoin Core regtest transactions and the read-only Garden SQLite corpus.
See [CRC_CORE_INTEGRATION.md](docs/CRC_CORE_INTEGRATION.md) for contracts and evidence.

## Local regtest development

Use Node 20 or newer, pnpm 10.33.0 and Docker, with the standalone Guardian checkout
at `../guardian`. Its synced CRC sources must match this repository.

```sh
cp -f .env.example .env
pnpm install --frozen-lockfile
pnpm dev:stack
```

The stack runs Bitcoin Core, PostgreSQL, the CRC worker, web and separate Guardian.
Public fixture keys and activation settings are regtest-only. `pnpm dev:db` applies
all committed migrations, including the explicit CRC replacement reset. Migration
0041 drops the obsolete CRC tables and clears CRC core/application records; shared
application infrastructure remains intact. There is no backfill.

For host web/worker development after starting the infrastructure and Guardian:

```sh
pnpm dev:infra
pnpm dev:guardian:docker
pnpm dev
```

## Verification

```sh
pnpm exec turbo run typecheck lint test --concurrency=1
pnpm exec turbo run build --concurrency=1
pnpm test:garden-corpus
pnpm --filter @crclaunch/web test:e2e
```

The default E2E owns isolated regtest Core and PostgreSQL containers, an independent
Guardian service and a production web copy. Browser wallet callbacks sign only
public regtest fixtures; this does not prove actual extension signing.
`test:e2e:crc-core` compares desktop/mobile screenshots and interactions against an
owned server at the baseline commit. Its default ports are 3118 and 3119.

Serial builds avoid the separately tracked shared Docusaurus output race.

## Release status

Mainnet is not enabled. Actual extension signing and the funded two-account Signet
canary remain open release gates. A prepared Signet deployment uses the standalone
`docker-compose.signet.yml`, matching web/worker/Guardian profiles and an empty CRC
namespace. Do not merge the regtest Compose environment into Signet. The operator
must provide the test profile, service credentials and explicit wallet authorization.

Shared non-CRC infrastructure and historical research remain in the repository.
They are not alternate application protocol paths.
