<p><img src="docs/assets/covs-logo.png" alt="covs" width="96" /></p>

# covs.trade

> covs.trade — covenant-powered CRC launchpad on Bitcoin.

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
For a hosted signet RPC such as Tatum, set `COVE_NETWORK=signet`,
`COVE_BITCOIN_RPC_URL=https://bitcoin-signet.gateway.tatum.io`, and
`COVE_BITCOIN_RPC_API_KEY` on the web and worker. The key is sent in the
`x-api-key` header; leave `COVE_BITCOIN_RPC_USER` and
`COVE_BITCOIN_RPC_PASSWORD` unset. The local `scripts/signet-up.sh` starts its
own Bitcoin Core node and does not use this hosted-RPC setup.

Build the Simplicity predicate and verify the frozen CMRs:

```bash
cd packages/cove-simplicity/rust && cargo build --release
```

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

## Mainnet status

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
