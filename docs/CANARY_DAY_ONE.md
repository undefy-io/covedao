# Canary Day One — Runbook

This is the exact, ordered procedure to go from an **all-null public profile** to
a **confirmed, self-only mainnet canary**. It assumes Phase 8.1 is complete
(`docs/PHASE8.1_REPORT.md`) and the mainnet readiness gate CI is green. It never
asks you to put a private key in the repo, fund anything ahead of the canary, or
broadcast until the very last, human-approved step.

## 0. Read this first — the trade we are making

**Running the Guardian on a VPS instead of a dedicated HSM is a deliberate,
temporary trade.** It is acceptable **only while**:

- the canary allowlist is **you and only you** (your wallet script), and
- the caps are small (≤ 0.01 BTC backing, ~0.002 BTC per op).

It is **NOT acceptable** once any third party can deposit. Before that point,
move the Guardian signing key to a hardware signer / KMS / remote custody service
per `docs/GUARDIAN_CUSTODY.md`. A VPS-hosted key is a "warm" key — treat it as a
burner whose compromise is bounded by the allowlist + caps.

---

## 1. Generate the two keypairs (offline, air-gapped)

Run on a machine that will **not** host the app or the Guardian:

```bash
pnpm cove:ceremony-keys --recovery-keys 1 --out /Volumes/ceremony/keys
```

It writes `guardian.key` and `recovery-1.key` (hex, mode 0600) to `--out`,
and prints **only** their two x-only BIP340 pubkeys:

```
guardian      <64-hex>
recovery-1    <64-hex>
```

- Keep the recovery key offline, separate from the Guardian service, with a backup.
- The x-only pubkeys are **public** — that's what goes into the profile.
- Never put a `.key` file in the repo (they are gitignored; confirm with
  `git status --short` shows nothing new).

## 2. Fill the profile

Edit the committed profile, `packages/cove-mainnet/src/committed-profile.ts`
(public values only), and fill:

| Field | Value |
|---|---|
| `guardianXOnly` | the `guardian` x-only pubkey from step 1 |
| `recovery.threshold` | `1` (the simple one-key recovery option) |
| `recovery.pubkeys` | the single `recovery-1` x-only pubkey |
| `recovery.csvBlocks` | `2016` (≈2 weeks) |
| `activationHeight` | a **future** block height (see below) |
| `feeScript` | leave `null`: set `COVE_FEE_ADDRESS` (your fee wallet's `bc1…` address) on web, worker and Guardian |
| `buyFeeBps` / `redeemFeeBps` | `100` (1%) |
| `p2pFeeBps` | `50` (0.5%) |
| `canary.allowedWalletScripts` | **only your wallet script** |
| `canary.allowedTokenIds` | the single precomputed tokenId from launch prep |
| `canary.maxBackingSats` / `maxSingleBuySats` / `maxSingleRedeemPayoutSats` / `maxP2pSettlementSats` | the caps from §7 |

Validation refuses any key or script controlled by the repo's public test
keys. Commit the change: web, worker and Guardian must run the same commit,
because they compare the profile hash.

**`activationHeight`:** choose a block height that is still in the future so the
indexer begins indexing Cove ops exactly at `H`. (`getblockchaininfo` for the
current tip, then add margin.)

## 3. Static readiness

```bash
pnpm cove:v3-mainnet-readiness --static
```

Expected: every `profile completeness` / `protocol profile match` / `recovery
profile` / `fee schedule` / `canary *` line `PASS`, and:

```
STATIC_PROFILE_READY
```

If it prints `READY_EXCEPT_FOR_OPERATOR_CEREMONY` with `OWNER_DECISION_REQUIRED`,
a field is still null — fix it before continuing.

## 4. Deploy the Guardian as its own service

`apps/guardian` is a standalone Node HTTP service. Run it as a service of its
own (on Railway: its own service in the project); `GUARDIAN_KEY_HEX` must exist
nowhere else. Its environment is exactly (see `apps/guardian/.env.example`):

```bash
COVE_NETWORK=mainnet \
COVE_DATABASE_URL=postgres://… \
COVE_BITCOIN_RPC_URL=https://… \
GUARDIAN_AUTH_TOKEN=<strong-random-token> \
GUARDIAN_KEY_HEX=<guardian private key, 64 hex> \
pnpm --filter @crclaunch/guardian start
```

It listens on port 4391 (committed). It refuses to start if the key does not
match `guardianXOnly`, if `COVE_BITCOIN_RPC_URL` is not on the main chain, or
if the committed profile does not validate. There is no `exportPrivateKey` and
no generic sign endpoint.

The web app then needs `COVE_GUARDIAN_ENDPOINT` (on Railway:
`http://<guardian>.railway.internal:4391`; elsewhere `https://…`) and
`COVE_GUARDIAN_AUTH_TOKEN` set to the same token.

Health check (only public info):

```bash
curl -s http://guardian-host:4391/health -H "Authorization: Bearer <token>"
# {"reachable":true, "profileHash":"…", "guardianXOnly":"…", "custodyBackendReady":true, "auditHealthy":true,
#  "signingJournalHealthy":true, "signingEnabled":true, …}   ← probed live, not fixed values
```

Confirm `guardianXOnly` equals the profile value and `profileHash` equals the
output of step 3.

## 5. Runtime readiness

The runtime probe is fail-closed: it compares against **committed** hashes and
contacts the real indexer DB + worker lock, so pass all of these in:

```bash
COVE_V3_MAINNET_PROFILE_HASH=<committed-profile-hash> \
COVE_V3_MAINNET_STATE_ROOT=<committed-replay-state-root> \
COVE_V3_MAINNET_RELEASE_MANIFEST_HASH=<committed-release-manifest-hash> \
COVE_DATABASE_URL=postgres://… \
COVE_BITCOIN_RPC_URL=http://primary-core \
COVE_BITCOIN_RPC_URL_SECONDARY=http://secondary-core \
COVE_GUARDIAN_ENDPOINT=http://guardian-host:4391 \
COVE_GUARDIAN_AUTH_TOKEN=<token> \
pnpm cove:v3-mainnet-readiness --runtime
```

- `COVE_V3_MAINNET_PROFILE_HASH` is the hash of the committed profile (from step 3);
  a missing or mismatched hash ⇒ `DISABLED` (the CLI no longer self-compares).
- `COVE_V3_MAINNET_STATE_ROOT` is the committed replay state root the indexer must
  reach; `COVE_V3_MAINNET_RELEASE_MANIFEST_HASH` is the committed release-manifest hash.
- `COVE_DATABASE_URL` lets the CLI probe the indexer health/state root and the
  worker's advisory lock (a real worker-health signal, not an assertion).

Expected: primary/secondary Core, Core agreement, indexer health, state root,
worker, Guardian (reachable / profile hash / key), custody backend, audit,
signing journal all `PASS`, and:

```
READY_FOR_CONTROLLED_MAINNET_CANARY
```

## 6. Arm + first canary op (the only broadcast)

1. Arm the canary (`canaryActive = true`) — the stage moves to `CANARY_ACTIVE`
   and `mutationsEnabled` flips true.
   Set `COVE_V3_CANARY_ACTIVE=1` on both web and Guardian and restart those
   services. Both independently refuse mainnet mutations while it is unset.
2. Perform the **first** canary op — a single DEPLOY of the precomputed tokenId,
   then a single MINT to your own wallet — using the app's mutation path. That
   path enforces the canary wallet/token allowlist at the app layer, and the
   Guardian signer enforces the token allowlist **and** the caps (single-buy /
   single-redeem-payout / backing) inside the signing boundary, signing only
   through the remote Guardian — a compromised web/API cannot bypass either.
3. Watch the durable audit + signing journal and the backing invariant.

Do **not** proceed to public deposits — the allowlist is still you, and the
Guardian is still on a VPS.

## 7. Recommended starting caps (self-only, sanity-checked)

| Cap | Value | Sanity |
|---|---|---|
| `maxBackingSats` | `1000000` (0.01 BTC) | ✓ ≫ anchor (10 000); ≈5 × a 200 000-sats buy |
| `maxSingleBuySats` | `200000` | ✓ ≫ min gross for a non-dust fee (see below) |
| `maxSingleRedeemPayoutSats` | `200000` | ✓ payout ≫ dust (294) |
| `maxP2pSettlementSats` | `200000` | ✓ p2p fee at 50 bps = 1000 sats > dust |

**Fee-bps interaction to watch:** the protocol fee output must be non-dust
(P2WPKH dust = 294 sats). A gross of 200 000 sats produces fee = `200000 × bps / 10000`:

- at `buyFeeBps = 100` (1%) → fee = 2000 sats ✅
- at `buyFeeBps = 10` (0.1%) → fee = 200 sats ❌ below dust → `PROTOCOL_FEE_DUST`

So keep `buyFeeBps`/`redeemFeeBps` ≥ **20** (0.2%) with these caps, or raise the
caps. Recommended: `100` bps buy/redeem, `50` bps p2p (self-paid during a
self-only canary, and every fee output stays non-dust). Nothing else breaks: the
geometric20 curve accepts any amount above `MIN_CONTRIBUTION_SATS` (1000 sats),
and `maxBackingSats` is far above the 10 000-sats anchor.

## Rollback

Disarm the canary (`COVE_V3_CANARY_ACTIVE=0` on both web and Guardian, then
restart them) or clear the profile hash — the stage falls back to
`CANARY_READY`/`READ_ONLY`, no new signs. If a backing invariant
fires, follow `docs/runbooks/RECOVERY_PROCEDURE.md` (never a compensating tx).

## Never

- Generate production keys with this agent, fund a mainnet wallet ahead of the
  canary, or broadcast until step 6's human-approved first op.
- Put a private key, WIF, or KMS credential in the repo or in `stdout`.
