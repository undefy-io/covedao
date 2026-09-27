# Architecture (Cove V3)

## Components

```
            ┌───────────────────────────────┐
            │  Browser: Next.js UI + wallet  │  Xverse / Unisat / Leather sign PSBTs
            └───────────────┬───────────────┘
                            │ HTTP (API routes)
            ┌───────────────▼───────────────┐        ┌──────────────────────────┐
            │  apps/web                     │ bearer │  apps/guardian            │
            │  quotes, PSBT builds, submit, ├───────►│  GET /health, POST /sign  │
            │  read models, P2P market      │  token │  MINT/REDEEM only         │
            └───┬───────────────────┬───────┘        │  holds GUARDIAN_KEY_HEX   │
                │                   │                └───┬──────────────┬────────┘
                │ reads             │ RPC                │ journal,     │ RPC (own view:
                │                   │                    │ audit, index │ confirmations)
        ┌───────▼───────┐   ┌───────▼────────┐          │              │
        │  PostgreSQL   │◄──┤  Bitcoin Core  │◄─────────┼──────────────┘
        │  index + app  │   │  (JSON-RPC)    │          │
        │  stores       │◄──┐└───────▲───────┘          │
        └───────────────┘   │        │ blocks           │
                            │ ┌──────┴─────────┐        │
                            └─┤  apps/worker   │        │
                     writes   │  V3 indexer,   │        │
                              │  reconcile     │◄───────┘ (same database)
                              └────────────────┘
```

- **apps/web** builds every PSBT, asks the user's wallet to sign it, and on
  mint/redeem asks the Guardian to sign the vault input. It never signs a
  vault input itself on mainnet.
- **apps/worker** follows Bitcoin Core block by block, applies Cove
  transitions deterministically to Postgres (with an undo journal for
  reorgs), and reconciles market fills and app sessions. It never calls the
  Guardian.
- **apps/guardian** is the only process with the Guardian key. It rebuilds
  the canonical state from its own view of the database, re-validates the
  real PSBT (reference policy + Simplicity predicate), checks funding inputs
  against its own node and an ord server, journals, audits, then signs the
  MINT or REDEEM leaf.

## Configuration

Environment variables carry only secrets and per-deploy endpoints.
Everything else is committed:

| What | Where |
| --- | --- |
| Mainnet profile (activation height, Guardian key, recovery keys, fees, canary caps) | `packages/cove-mainnet/src/committed-profile.ts` |
| Per-network settings (V3 on, worker poll, Guardian port, explorer, esplora, ord) | `packages/config/src/cove-networks.ts` |
| Protocol constants (curve, CMRs, carrier/anchor sats, vault profile) | the protocol packages; frozen |

`COVE_NETWORK` is required by every service; there is no default. The env
each service reads is listed in `apps/*/.env.example`:

| Service | Env |
| --- | --- |
| web | `COVE_NETWORK`, `COVE_DATABASE_URL`, `COVE_BITCOIN_RPC_URL`, `COVE_GUARDIAN_ENDPOINT`, `COVE_GUARDIAN_AUTH_TOKEN`, `COVE_FEE_ADDRESS`, `COVE_V3_CANARY_ACTIVE` |
| worker | `COVE_NETWORK`, `COVE_DATABASE_URL`, `COVE_BITCOIN_RPC_URL`, `COVE_GUARDIAN_ENDPOINT`, `COVE_GUARDIAN_AUTH_TOKEN`, `COVE_FEE_ADDRESS` |
| guardian | `COVE_NETWORK`, `COVE_DATABASE_URL`, `COVE_BITCOIN_RPC_URL`, `GUARDIAN_AUTH_TOKEN`, `GUARDIAN_KEY_HEX`, `COVE_FEE_ADDRESS`, `COVE_V3_CANARY_ACTIVE` |

RPC user and password are optional (hosted providers put the key in the
URL). Mainnet refuses to start while the committed profile is incomplete,
while any `COVE_*_PRIVATE_KEY_HEX` is set on web or worker, or when the
Guardian key does not match the profile.

`COVE_FEE_ADDRESS` is the one address every protocol fee is paid to. It fills
the profile's `feeScript` before the profile is hashed, so set it once (a
shared variable) for all three services: web and worker compare their profile
hash with the Guardian's at startup and stop on a mismatch.

Local regtest keeps its fixture defaults (local node, public test keys) once
`COVE_NETWORK=regtest` is set in the repo-root `.env`. Regtest CI may name a
test profile with `COVE_TEST_ONLY_PROFILE_PATH`; that is refused on mainnet.

## Packages

| Package | Purpose |
| --- | --- |
| `cove-wire` | Binary `CV` OP_RETURN envelope, token identity, crc-20 discovery JSON |
| `cove-covenant` | State encoding, state hash, transition rules |
| `cove-vault` | Taproot vault (NUMS key, MINT/REDEEM leaves, 2-of-3 or 1-of-1 recovery) |
| `cove-simplicity` | Simplicity predicates (Rust) run by the Guardian |
| `cove-economics`, `curve` | 210-stair curve, fees, creator share |
| `cove-guardian` | PSBT builders, validation, signing, funding checks, custody backends |
| `cove-indexer` | Deterministic V3 indexer, state root, reorg handling, Postgres store |
| `cove-market` | P2P listings and atomic PSBT settlement |
| `cove-mainnet` | Committed mainnet profile, validator, hash, test-key denylist |
| `cove-app` | Application service used by web and worker |
| `config` | Committed per-network settings (browser-safe) |
| `wallets`, `bitcoin`, `db` | Wallet intent checks, Bitcoin providers, Drizzle schema |

`packages/protocol` and the V1 worker (`pnpm --filter @crclaunch/worker
start:v1`) are the earlier design, kept for their regression suites.

## Invariants

- All money math is `bigint`; Postgres money columns are `BIGINT`.
- The browser and web API are untrusted: the Guardian recomputes every
  amount from canonical state and the real transaction before signing.
- A vault outpoint is signed at most once (Postgres signing journal), and
  every signature is preceded by a durable audit record.
- Mint and redeem funding inputs must be confirmed and hold no tokens of any
  kind (Cove carriers, inscriptions, runes).
- The indexer's state root is deterministic: an incremental index after a
  reorg equals a clean replay.
