<p><img src="docs/assets/covs-logo.png" alt="covs" width="96" /></p>

# covs.trade

> covs.trade — a Bitcoin token launchpad under active CRC-20 cutover.

## CRC-20 release status

The new Cove-issued CRC-20 path is selected with `COVE_PROTOCOL_MODE=crc20`.
It uses CRC-20 JSON markers, a Cove-specific curve, a confirmed-block indexer,
and a separate Guardian service. Launch, buy, and sell are implemented behind
`COVE_CRC_TRADING_ACTIVE` and have passed a real Bitcoin Core regtest cycle,
including Guardian-signed buy and sell, repeated trades, and reorg rollback.
New deployments use the single [Garden-shaped CRC wire profile](docs/COVE_CRC20_GARDEN_WIRE.md)
with Cove token authority bound to spendable outputs.

**This is not a public mainnet release yet.** The mainnet profile still needs
operator public parameters and a live signet marketplace canary has not
reconciled. Market fills spend the exact listed token output and require
complete-transaction signatures. Activation remains controlled by the release
configuration.

The remaining sections describe the earlier V3 implementation, which stays
available under `COVE_PROTOCOL_MODE=legacy`. Its binary `CV` envelope and
mainnet instructions do not describe the new CRC-20 wire format.

## Legacy V3 design

**covs — a CRC-family token launchpad on Bitcoin L1 — state-committed Taproot UTXOs,
an open indexer, and a non-custodial marketplace.**

Cove issues tokens whose protocol state is committed into the Taproot output
key of a live UTXO. A token's history is a chain of on-chain state transitions —
`DEPLOY → MINT → TRANSFER → REDEEM` — each one an ordinary, consensus-valid
Bitcoin transaction. Anyone can run the indexer and independently reproduce the
same state root from the same blocks.

Cove sits in the CRC category but runs its own protocol. The authoritative
record is a binary OP_RETURN envelope tagged **`CV`**; an optional second
OP_RETURN carries `crc-20` JSON so CRC explorers can see Cove tokens, but it is
advisory and never read into state. Own ledger, open indexer, reproducible
state.

---

## What Bitcoin enforces, and what it does not

This is the first thing to understand about Cove, and we state it plainly
rather than burying it.

**Bitcoin enforces:** the Taproot signature on the spend, the UTXO set (no
double-spend, no inflation of BTC), and that the successor output exists with
the exact value and script the transaction commits to.

**Bitcoin does not enforce the token rules.** A Guardian validates each
transition — supply conservation, the issuance curve, payment amounts, the
recovery profile — and signs only if it passes. Bitcoin will not reject an
invalid Cove transition; the indexer ignores it.

So Cove is **client-validated**, like every Bitcoin metaprotocol today. There
are no covenants on Bitcoin mainnet — every proposal (CTV, OP_CAT, APO, CSFS)
is still a draft. What Cove does differently is make the validator reproducible:
the indexer is in this repository, the state root is deterministic, and two
independent operators can check each other. See
[`docs/TRUST_MODEL.md`](docs/TRUST_MODEL.md) for the full model.

---

## How it works

```
DEPLOY ──► state-committed P2TR vault (NUMS internal key, MAST)
             │
   MINT ─────┤  Guardian validates the real PSBT, runs the Simplicity
             │  predicate, then signs the execution leaf
             ▼
           successor vault  (new state → new output key → new address)
             │
TRANSFER ────┤  token UTXOs move between owners
REDEEM ──────┘  burn tokens, release the backing BTC
```

Each vault's output key is `Q = P + H_TapTweak(P ‖ stateCommitment)·G`, so the
address itself is a commitment to the protocol state. The vault carries three
tapleaves: MINT and REDEEM execution paths bound to a Simplicity program
commitment (CMR), and a **threshold recovery leaf** (2-of-3, or 1-of-1) behind
a relative timelock.

The issuance curve is a frozen 210-stair integer staircase. All arithmetic is
`bigint`; there is no floating point anywhere in the consensus path.

---

## Repository layout

| Package | Purpose |
| --- | --- |
| `packages/cove-wire` | Wire envelope: fixed-width binary, versioned, `CV` magic |
| `packages/cove-covenant` | State encoding, state hash, transition rules |
| `packages/cove-vault` | Taproot vault construction, MAST, recovery profiles |
| `packages/cove-simplicity` | Simplicity predicate (Rust) + Bit Machine execution |
| `packages/cove-guardian` | Transition validation and signing; custody backend interface |
| `packages/cove-indexer` | Deterministic indexer, state root, reorg recovery, Postgres |
| `packages/cove-market` | Signed listings, PSBT atomic settlement, reconciliation |
| `packages/cove-economics` | Frozen issuance curve and fee schedule |
| `packages/cove-mainnet` | The committed mainnet profile: schema, parser, validator, hash |
| `packages/config` | Committed per-network settings (explorer, ports, ord server, …) |
| `packages/cove-app` | Application service, readiness aggregation, durable stores |
| `packages/cove-recovery` | Offline threshold-recovery tool |
| `packages/bitcoin` | PSBT construction, dust policy, Core RPC and Esplora providers |
| `apps/web` | Next.js application |
| `apps/guardian` | Guardian service copy retained for existing CI; standalone source is in the separate `guardian` repository |
| `apps/worker` | V3 indexer worker (`start`); the V1 mock worker is `start:v1` |

`packages/protocol`, `packages/curve` and the V1 paths under `docs/legacy/` are
the earlier OP_RETURN/indexer-authoritative design, retained for its regression
suite. New work targets the Cove V3 packages above.

---

## Getting started

Requires Node 22, pnpm 10, and Docker. Docker builds the Simplicity Rust binary.

```bash
pnpm install
cp .env.example .env          # local regtest; sets COVE_NETWORK=regtest
pnpm dev:stack                # web, worker, Guardian, Postgres and Bitcoin Core in Docker

pnpm typecheck && pnpm lint && pnpm test
```

`pnpm dev:stack` builds the Rust executable in Docker, applies the local database
schema, and waits for the web, worker, and Guardian health checks. The web app is
at `http://localhost:3000`; Guardian listens on `127.0.0.1:4391`. Docker Compose
restarts the services if they exit. Use `docker compose ps` and
`docker compose logs -f web worker guardian` to inspect them.
Run `pnpm dev:stack` again after source changes to rebuild the local images.

`pnpm dev:infra` mines 101 blocks and funds the dev wallet identities (alice,
bob, carol) on a fresh chain, then a miner container mines a block every 10 s
(`MINE_INTERVAL`). On regtest the web app runs the Guardian policy in-process
with the public test keys, so the separate Guardian service is not needed for
normal app testing. The separate Guardian in the full Docker stack is built
from the sibling `guardian` repository at `../guardian`. Check it with
`curl -H 'Authorization: Bearer local-dev' http://127.0.0.1:4391/health`.
The regtest web app does not call that HTTP service; mainnet uses
the remote Guardian. Stop local infrastructure with `pnpm dev:infra:down`;
wipe the chain and database with `pnpm dev:infra:reset`.

For host-run development with live reload, run `pnpm dev:infra`, build the Rust
executable under `packages/cove-simplicity/rust`, then run `pnpm dev`. Stop the
Docker web and worker services first if the full stack is running, since they
use the same port and database worker lock.

Fees go to `COVE_FEE_ADDRESS` from `.env` (a local-only regtest address in
`.env.example`), as on mainnet; `pnpm dev:fees` shows what it has collected.

Browser wallets do not support regtest, so locally **Connect** lists the
built-in test wallets (alice, bob, carol) with their BTC. They sign on the
server with the public fixture keys; disconnect and connect again to switch.

`COVE_NETWORK` is required by every service; nothing defaults to regtest.
Everything that is not a secret or a per-deploy endpoint is committed:
per-network settings in `packages/config/src/cove-networks.ts`, the mainnet
profile in `packages/cove-mainnet/src/committed-profile.ts`. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#configuration).

Signet with real browser wallets: `scripts/signet-up.sh`.
For the public signet RPC tested with the Docker stack, set
`COVE_NETWORK=signet` and
`COVE_BITCOIN_RPC_URL=https://bitcoin-signet-rpc.publicnode.com` on the web
and worker, with `COVE_BITCOIN_RPC_API_KEY`, `COVE_BITCOIN_RPC_USER`, and
`COVE_BITCOIN_RPC_PASSWORD` unset. A hosted provider such as Tatum also works:
use its signet URL and put its key in `COVE_BITCOIN_RPC_API_KEY`. The key is
sent in the `x-api-key` header. `scripts/signet-up.sh` starts its own Bitcoin
Core node and does not use either hosted RPC.

For the local Docker signet CRC stack, keep `.env.signet.local` (gitignored) with
one of the RPC settings above, `COVE_DATABASE_URL` and `DATABASE_URL` both set to
`postgres://cove:cove@postgres:5432/cove_signet`, signet-only
`COVE_GUARDIAN_PRIVATE_KEY_HEX`, `COVE_RECOVERY_PRIVATE_KEY_HEX`, and
`COVE_FEE_PRIVATE_KEY_HEX`, plus `COVE_ACTIVATION_HEIGHT`, `SENTRY_DSN`, and
`SENTRY_ENVIRONMENT=dev`. Set `COVE_GUARDIAN_AUTH_TOKEN` to a random local
secret. Set the activation height before the first Cove transaction and keep
it and the keys fixed on restarts. The CRC stack builds the separate Guardian
repository at `../guardian`. Generate the local public profile from those
existing signet keys before building. This Compose stack creates its own
Postgres volume and runs migrations automatically:

```bash
node scripts/signet-crc-profile.mjs
docker compose --env-file .env.signet.local -f docker-compose.signet.yml build
docker compose --env-file .env.signet.local -f docker-compose.signet.yml stop web worker
docker compose --env-file .env.signet.local -f docker-compose.signet.yml up -d --no-build --wait
# App: http://127.0.0.1:3000
curl http://127.0.0.1:3000/api/crc/v1/trading/status
curl http://127.0.0.1:3000/api/crc/v1/market/status
```

The production image builds the application once, then the web starts with
`next start`. The worker warms database observations before the web starts.
Allow about a minute for the image build. This gives stable request timings without
development-time route compilation. Rebuild the image to apply source changes;
the build uses the network and public Sentry settings from `.env.signet.local`.
Before the first authorized CRC launch, the token catalog and wallet balances
are empty. After that launch is registered and confirmed, the CRC worker
indexes from the configured activation height. The Compose web service
sets `COVE_CRC_MARKET_TESTING_ENABLED=true`, which opens marketplace listing
and fill endpoints on signet for wallet testing. This switch cannot open
mainnet or testnet. To test a sale, connect a funded signet seller wallet,
create and buy a Cove token, and list one whole token output on `/wallet`.
Connect a second funded signet wallet on `/market` to reserve and sign the buy, then return
to the seller wallet to review, sign, and broadcast. After confirmation, check
the buyer's token balance and the seller's BTC payout. Mainnet marketplace
activation still requires the live wallet canary and release gate tracked in
Beads.

With at least one confirmed Cove token on the local signet stack, run
`pnpm test:e2e:crc` to check the live catalog, token history, indexed price chart,
quote preview, canonical page URLs, and navigation in desktop and mobile Chromium.
The old `/crc/...` page routes are removed. Use `/explore`, `/launch`, `/market`,
`/activity`, `/wallet`, and `/token/{assetId}`. This browser check is read-only.
The launch form saves name, description, website, X, and image URL as Cove display
metadata after the wallet signs the deploy. The CRC-20 transaction keeps the
Garden-compatible ticker and wire format; existing tokens without display
metadata show their ticker as the name.
Launch mining speed is selected during review. The CRC worker refreshes fee
rates in the database each minute; the build sizes the actual miner fee from
the selected rate and transaction shape, then shows the exact sats before signing.
The CRC buy submission integration test covers wallet and Guardian signatures,
PSBT finalization, and broadcast against the isolated test database; set
`CRC_READ_TEST_DATABASE_URL` to that database before running the web tests.

To stop signet without deleting its database, run
`docker compose -f docker-compose.signet.yml stop`. After that,
`pnpm dev:stack` starts the retained regtest stack again.

Build the Simplicity predicate and verify the frozen CMRs:

```bash
cd packages/cove-simplicity/rust && cargo build --release
```

The worker writes chain observations and fee estimates to `cove_v3_runtime`.
`/api/v3/status` and `/api/v3/fees` read these database snapshots without RPC
calls. Chain observations refresh on the worker polling interval; observations
older than 30 seconds (or three polling intervals, if longer) are marked stale.
Fee previews refresh once per minute and become unavailable after two minutes
without an update. Run migrations and the worker before serving these endpoints.
Transaction builds use the same fresh worker fee observation and still validate
current chain health and spendable inputs against RPC. Failed fee refreshes do
not renew the stored timestamp. Funding checks share a chain height/hash within
each validation and reject outputs observed at a different tip.
Quotes following unconfirmed transactions also use RPC;
confirmed token data, holders, activity, and charts come from the indexer database.

Public transaction status uses indexed confirmation first and probes RPC only
for transactions tracked by the app or market. A provider failure returns
`state: "unknown"`, never proof of a dropped transaction. Public transaction and
fill status omit signing data and use `Cache-Control: no-store`.

### Durable transaction submission

The app saves the wallet request before asking the Guardian to sign, then saves
its exact finalized transaction before broadcasting. The existing worker recovers
up to two due submissions per loop. Claims last two minutes; failed attempts wait
one minute. Retries reuse the saved bytes and transaction ID. No new environment
variables or deployment services are needed.

Submit responses may include `submissionState: "saved"`: the transaction is
stored for recovery but node acceptance is still unconfirmed. `"broadcast"`
means acceptance was verified. Neither proves a block confirmation. A definite
validation rejection pauses automatic signing until an explicit wallet retry.
Saved Guardian signatures remain immutable for each transaction candidate. Signed PSBTs and
raw transactions stay private in the database and require protected backups.

Migration `0014_durable_submissions.sql` adds the submission records and stored
Guardian signing results. Drain the old web and worker processes before applying
migrations and starting the updated Guardian, web, and worker; old writers do not
honor the new submission states. Both repositories carry the same migration
history when they share a database. Apply that history once per database.
The separate Guardian verifies up to 24 pending vault ancestors against its
own signing journal and node. Each parent must remain in the mempool, connect
to indexed backing, and pass signature, state, successor and fee checks. New
signing also verifies wallet signatures and live token inputs. Tip or indexer
changes abort validation; an exact signed retry can recover its original
signature without signing again. Let legacy pending transactions without stored
signing results confirm before this rollout. Database-only pending quotes/status
remain in the API scaling plan.

### Competing vault transactions

The Guardian signs each independently valid candidate, including competing
transactions spending the same backing output. Its journal is keyed by network,
backing outpoint and unsigned transaction digest. A saved signature does not
reserve the vault against other users. Bitcoin chooses the canonical spend;
being signed or accepted into the mempool does not guarantee confirmation.

Quotes follow the node's accepted mempool branch using `gettxspendingprevout`.
An explicitly unsupported method uses bounded candidate membership checks;
provider failures abort the quote. Missing candidates can expose the parent only
when the node verifies that parent is still unspent. Descendants of a replaced
branch require a fresh quote. Transaction status reports `conflicted` when the
indexed chain proves a competing spend, including an ancestor conflict, and
re-evaluates that evidence after reorgs. Pending absence remains `unknown`.

Migration `0015_competing_signatures.sql` replaces the journal's unique outpoint
index with a unique candidate index without deleting saved signatures. Stop old
Guardian, web and worker writers, apply the shared migration history once per
database, then start the matching releases together. The live stack is not
updated merely by pulling this code.

### Public read limits

| Read | Limits and behavior |
| --- | --- |
| Holders | `limit` defaults to 100, maximum 200; `offset` maximum 10,000. Sorted by balance, then script. |
| Wallet portfolio | `limit` defaults to 100, maximum 500; `offset` maximum 10,000. Each collection has a `pagination.hasMore` flag. Holdings contain the complete balance of each returned token. |
| Buy routes | Cheapest 100 matching P2P listings, plus the backing route when available. |
| Sell options | Complete redeem balance; up to 200 listable outputs with `listableUtxosHasMore`. |
| Sparklines | Latest 32 chronological hourly prices, carrying prices through empty hours; latest raw trade price returned separately. |

The wallet UI follows portfolio pages before selecting token inputs, with a
10,000-record cap. Oversized portfolios return an error instead of a partial
balance. Exact balance and holder aggregates still scale with matching live
outputs. Pagination can change as new records arrive; public caches are fenced by indexed and off-chain revisions.

Migration `0013_bounded_public_reads.sql` adds indexes for these queries. Apply
it before deploying the updated readers. Index creation can block writes on
large tables, so schedule migration maintenance for a populated production DB.

---

## Proofs

Every claim in this repository has an executable proof against real Bitcoin
Core — not a mock. These run in CI on every push to `main` and every pull
request.

```bash
pnpm cove:regtest-proof            # state-committed vault spend
pnpm cove:csv-proof                # NUMS/MAST, 144-block CSV recovery leaf
pnpm cove:v3-regtest-lifecycle     # DEPLOY → MINT → TRANSFER → REDEEM
pnpm cove:regtest-reorg            # reorg recovery, root == clean replay
pnpm cove:signet-proof             # signet lifecycle, real broadcast
```

| Workflow | Proves |
| --- | --- |
| `ci` | typecheck, lint, test, build |
| `cove-v3-lifecycle` | full lifecycle against real `bitcoind` |
| `cove-v3-indexer` | persistence, reorg recovery, backup/restore round-trip |
| `cove-v3-market` | P2P listing, fill, settlement |
| `cove-v3-product` | browser end-to-end against a real node |
| `cove-simplicity` | Simplicity ↔ TypeScript differential, frozen CMRs |
| `cove-vault-csv` | vault script paths |
| `cove-v3-mainnet-readiness` | readiness gate against a real Guardian |

---

## Legacy V3 mainnet status

**Mainnet is not activated.** The committed profile
(`packages/cove-mainnet/profiles.toml`, `[networks.mainnet]`) still has placeholders for
every owner decision — activation height, Guardian key, recovery keys (2-of-3
or 1-of-1), fee destination and bps, canary allowlists and caps — so mainnet
refuses to start until they are filled in. The profile also refuses any key
or script controlled by the repo's public test keys.

### Railway: first self-only canary

The operator needs to provide these inputs before a canary deployment:

1. **Two distinct keys under your control:** one Guardian signing key and one
   offline recovery key. The simple profile uses 1-of-1 recovery; it does not
   require three recovery signers. Generate them offline with
   `pnpm cove:ceremony-keys --recovery-keys 1 --out <offline-drive>/keys`.
   Share only their public x-only keys for the committed profile. Put the
   Guardian private key in the Guardian service's Railway secret
   (`GUARDIAN_KEY_HEX`); keep the recovery private key offline and out of
   Railway, chat, and the repository.
2. **Two public Bitcoin addresses:** a fee-receiving address you control and
   the wallet address you will use for the self-only canary. These determine
   the fee destination and canary allowlist; the remaining profile values and
   activation height must be finalized before the first mainnet transaction.
3. **Service access:** a Railway project with PostgreSQL and credentials for
   Bitcoin Core RPC. Runtime readiness requires two Core endpoints that agree
   on the chain. Only the web service should be public; worker, database, and
   Guardian communicate privately. The recovery private key is never deployed.

Keep `COVE_V3_CANARY_ACTIVE=0` on web and Guardian until the migration, profile,
backups, and runtime readiness checks pass. Arming both services permits only
the committed canary wallet and token under its caps. The current
funding-after-signing liveness issue still blocks a **public user launch**;
this first deployment is for the operator's own small canary only.

Once the profile validates, mainnet runs as three services (web, worker,
Guardian) with only these env vars:

| Service | Env (see `apps/*/.env.example`) |
| --- | --- |
| web | `COVE_NETWORK`, `COVE_DATABASE_URL`, `COVE_BITCOIN_RPC_URL`, `COVE_GUARDIAN_ENDPOINT`, `COVE_GUARDIAN_AUTH_TOKEN`, `COVE_FEE_ADDRESS`, `COVE_V3_CANARY_ACTIVE` |
| worker | `COVE_NETWORK`, `COVE_DATABASE_URL`, `COVE_BITCOIN_RPC_URL`, `COVE_GUARDIAN_ENDPOINT`, `COVE_GUARDIAN_AUTH_TOKEN`, `COVE_FEE_ADDRESS` |
| guardian | `COVE_NETWORK`, `COVE_DATABASE_URL`, `COVE_BITCOIN_RPC_URL`, `GUARDIAN_AUTH_TOKEN`, `GUARDIAN_KEY_HEX`, `COVE_FEE_ADDRESS`, `COVE_V3_CANARY_ACTIVE` |

The web app reports browser, server, and API 500 errors to Sentry. Set `SENTRY_ENVIRONMENT=dev` for local testing and `SENTRY_ENVIRONMENT=prod` for the production web build and runtime. The web build requires `COVE_NETWORK`, `SENTRY_DSN`, and `SENTRY_ENVIRONMENT`; web and worker startup validate their required service variables with `envalid` before serving requests or indexing. Client variables are passed to `envalid` as explicit `process.env.NEXT_PUBLIC_*` properties so Next.js can inline them. The DSN is in the web and root `.env.example` files; no Sentry auth token is needed for error delivery.

The app and Guardian repositories must carry the same `packages/cove-mainnet/profiles.toml`. Its `[protocol]` values are shared and `COVE_NETWORK` selects a network section. Guardian validates env with `envalid` before service startup. The Guardian refuses to start unless `GUARDIAN_KEY_HEX` matches the profile's
`guardianXOnly`. On Railway the web may reach it over private networking
(`http://<guardian>.railway.internal:4391`); anywhere else it must be https.
The canary allowlists and caps in the profile are enforced on every mutation.

`COVE_FEE_ADDRESS` is the one address every protocol fee is paid to. It fills
the profile's `feeScript` before the profile is hashed, so set it once (a
shared variable) for all three services: web and worker compare their profile
hash with the Guardian's at startup and stop on a mismatch.

Check readiness at any time:

```bash
pnpm cove:v3-mainnet-readiness --static    # profile completeness
pnpm cove:v3-mainnet-readiness --runtime   # live Core, Guardian, indexer probes
```

Remaining work before a controlled canary is tracked in
[`docs/MAINNET_V3_CHECKLIST.md`](docs/MAINNET_V3_CHECKLIST.md); the operator
procedure is [`docs/CANARY_DAY_ONE.md`](docs/CANARY_DAY_ONE.md).

---

## Shared API capacity

`COVE_RPC_REQUESTS_PER_SECOND` is the combined provider allowance, including
retries. It defaults to 3 outside regtest and 90 on regtest. Set the same value
on web, worker and Guardian. PostgreSQL reserves a third of the rate and
concurrency for each of indexing/background work, Guardian verification, and
public transaction work. Requests receive retryable errors when capacity is
full. Wallets still support up to 64 funding inputs; a transaction with many
inputs takes longer on a small gateway allowance. Remote signing permits up
to three minutes, with bounded concurrent work and RPC deadlines.

The normal deployment shares the app database. If Guardian uses its own
canonical database but the same RPC account, set its
`COVE_RPC_BUDGET_DATABASE_URL` to the app database so all attempts use one
coordinator. A different provider budget configuration for an existing account
fails closed; drain the services before deliberately changing its saved policy.
No additional service is required.

Forwarded client IPs are ignored by default. Set
`COVE_TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip` or `x-real-ip` only when the
trusted ingress overwrites that header and direct access to the backend is
blocked. Shared global quotas still protect expensive operations without a
trusted client header. Do not set it to a header that callers can supply.

Wallet address lookups share a five-second cache, their own provider height,
response and concurrency limits. Indexed tip changes and accepted local
broadcasts invalidate cached balances. Core resolves funding again before a
transaction is signed; the address cache cannot authorize a spend.

Launch metadata belongs to a specific deployment transaction. Public token
reads join it to the canonical deployment, including after reorgs. Apply the
matching migrations before updating either application image.

---

## Security

Cove has been through three independent adversarial audits covering the
Guardian signing path, the activation gates, and the marketplace. Findings and
the fixes that closed them are in the git history.

**The Guardian key is the trust boundary.** Bitcoin enforces that funds move to
*a* state-committed successor; the Guardian decides *which*. A compromised
Guardian cannot inflate supply or steal backing satoshis — the policy engine
recomputes every amount from canonical state and validates the real
transaction — but it is the component to protect.
[`docs/GUARDIAN_CUSTODY.md`](docs/GUARDIAN_CUSTODY.md) covers backend options.

Key material is never held by the web app or worker. The Guardian holds its
key in `GUARDIAN_KEY_HEX` on its own service. The ceremony tool writes each
private key to a separate `0600` file and prints only x-only public keys:

```bash
pnpm cove:ceremony-keys --out /Volumes/<removable>/ceremony
```

> The WIF and `0x42`-style keys in the test suite are **publicly known burner
> keys**. Never fund them.

Report a vulnerability privately via GitHub Security Advisories rather than a
public issue.

---

## Documentation

| Document | |
| --- | --- |
| [`TRUST_MODEL.md`](docs/TRUST_MODEL.md) | What Bitcoin enforces vs. what the Guardian enforces |
| [`COVE_PROTOCOL_V1.md`](docs/COVE_PROTOCOL_V1.md) | Wire format, byte layout, test vectors |
| [`COVE_VAULT.md`](docs/COVE_VAULT.md) | Taproot construction, MAST, recovery |
| [`COVE_BACKING.md`](docs/COVE_BACKING.md) | Backing, issuance curve, redemption |
| [`COVE_MARKET.md`](docs/COVE_MARKET.md) | Listings, settlement, reconciliation |
| [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System overview |
| [`THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Threat model |
| [`GUARDIAN_CUSTODY.md`](docs/GUARDIAN_CUSTODY.md) | Custody backend selection |
| [`MAINNET_RECOVERY_CEREMONY.md`](docs/MAINNET_RECOVERY_CEREMONY.md) | Threshold recovery procedure |
| [`runbooks/`](docs/runbooks) | Backup/restore, canary operations, recovery |

---

## License

MIT

### Indexed-read release

Use `Dockerfile.prod` for the web, worker and one-off migration service. Build
with `COVE_NETWORK` and the public `SENTRY_DSN`/`SENTRY_ENVIRONMENT`; deploy each
image with that same network. Keep the private service variables in runtime
secrets. Run database migrations once, stop old workers, start the new worker,
and wait for its health check before serving the new web image. Keep a database
backup and the previous image tag. Additive migrations remain compatible with
the previous readers; rolling back does not require deleting tables or data.

Backing buy/redeem quotes and transaction status read durable database
observations. Missing, invalidated or pending observations older than 15 seconds
return retryable unavailability; there is no request-time RPC fallback. Unknown
transaction IDs do not enroll worker jobs. The worker observes the accepted
mempool branch, while confirmed spends and reorgs invalidate observations
atomically with the indexer cursor. Saved signed transactions with proven
canonical conflicts retain their bytes and pause retries until reconsidered
following a chain-generation change.

One browser status subscription coordinates indexed, pending, market and trade
refreshes. Hidden tabs pause it; resuming or locally submitting refreshes pending
data. Public success caches have bounded memory, short expiry and revision
fences. Wallet and private session responses remain uncached. The worker health
check reads database observations, so health probes spend no RPC quota.

The reproducible load harness is `scripts/testing/release-read-load.mjs`.
It only accepts the isolated database `127.0.0.1:5435/release_load` and web ports
3003/3004. Copy a successful isolated competing-regtest fixture into that database,
then run `seed`, `serve`, `run` and `faults` with `RELEASE_TEST_DATABASE_URL` set.
For a quick HTTP check, use `seed-smoke`, `serve`, `smoke` and `faults`. Build the
web image for regtest and set `COVE_REGTEST_MAX_MINT_GROSS_SATS=2100000000000000`
only on this isolated fixture server, matching the competition test limits.
The fixture clocks support synthetic read-load measurements; they must never run
against an application database. Real Core competing-spend tests and separate
Guardian HTTP integration tests independently verify branch selection and signing.

Measured results from the 2026-09-29 release are saved in
`scripts/testing/release-read-load-results.json`, including the old baseline,
production-image measurements, stale-observation checks, live worker freshness
and rollback verification. The signet rollback tag from this release is
`covedao-signet-rollback:pre-indexed-read`; that older development image needs
its original `pnpm build` before `next start`. New `Dockerfile.prod` images have
the web build included.
