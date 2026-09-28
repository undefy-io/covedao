# Runbook — Controlled Mainnet Canary Operations

## Purpose

The controlled canary is the ONLY path to public mainnet writes. Before the
canary, the protocol runs mainnet-READ_ONLY/SHADOW or stays DISABLED. This
runbook covers activating, monitoring, and rolling back the canary. It is
human-approved at every stage; no automation flips the stage.

## Stage model (deterministic, fail-closed)

`deriveMainnetStage(profile, canaryActive, health)` in `cove-app/src/mainnet.ts`
derives the stage from the committed profile + health. A missing/incomplete
profile or a mismatched profile hash ⇒ `DISABLED`. The stage advances only when
every required health signal is green:

- `DISABLED` — default; profile incomplete or hash mismatch.
- `READ_ONLY` — Core/indexer healthy but Guardian/audit/journal or state-root not
  fully verified; browsing only, no signing.
- `SHADOW` — full validation against a shadow (non-broadcast) signer.
- `CANARY_READY` — all gates green, canary not yet armed.
- `CANARY_ACTIVE` — human-armed canary; signer-side caps + allowlist enforced.
- `CANARY_COMPLETE` → `PUBLIC_READY` / `PUBLIC_ACTIVE` — only after canary
  exit criteria are met (NEVER reached implicitly).

## Preconditions (gate)

1. `Cove V3 — mainnet readiness gate` CI is green (no mainnet broadcast anywhere).
2. Operator ceremony complete: committed public mainnet profile
   (activation height, guardian X-only key, 2-of-3 or 1-of-1 recovery pubkeys + CSV,
   fee script, buy/redeem/p2p BPS, canary allowlist + caps) — see
   `MAINNET_RECOVERY_CEREMONY.md`.
3. Release manifest + secret scan clean; readiness CLI reports
   `READY_FOR_CONTROLLED_MAINNET_CANARY`.

## Activation (human-only)

1. Commit the public profile values (`packages/cove-mainnet/src/committed-profile.ts`); verify
   `node scripts/cove-v3-mainnet-readiness.mjs` reports the canary-ready state.
2. Arm the canary (set `canaryActive`) only after reviewing the canary
   allowlist + caps.
3. Confirm the signer enforces the risk policy (caps are INSIDE the signer, so a
   compromised web/API cannot bypass them).

## Monitoring (every canary block)

- `cove-app/src/metrics.ts` `Metrics` counters/gauges emitted by the worker each
  tick (market confirmations/broadcasts, active listings).
- `checkBackingInvariant` (backing == R(supply); btcValue == anchor + backing)
  and `checkSupplyInvariant` (sum unspent token UTXOs == issued supply) — any
  CRITICAL result halts signing.
- Guardian audit hash chain (`cove_v3_guardian_audit`) + signing journal
  (`cove_v3_signing_journal`): every candidate is validated and recorded before
  signing. Valid competing candidates are allowed; Bitcoin chooses the winner.

## Caps + allowlist (signer-enforced)

`GuardianRiskPolicy`: `maxGrossSats`, `maxRedeemPayoutSats`, `maxBackingSats`,
`maxMinerFeeSats`, and `allowedTokenIds` (null = any; a list = canary token
allowlist). Any violation ⇒ `RISK_POLICY_REJECTED` before audit/sign.

## Pause / rollback (fail-closed)

1. Disarm the canary (`canaryActive = false`) or clear the profile hash — the
   stage falls back to `CANARY_READY`/`READ_ONLY`/`DISABLED`; no new signs.
2. If a backing invariant is violated, do NOT attempt a compensating transition —
   follow `RECOVERY_PROCEDURE.md`.

## What must NOT be done

- Do not fund mainnet wallets, generate operator production secrets, or broadcast
  a real mainnet transaction from this repo/agent.
- Do not redefine committed economics via env (profile values are committed, not
  env-derived).
- Do not advance beyond `CANARY_ACTIVE` without the documented exit criteria.
- Do not load a local Guardian/recovery private key on mainnet (fail-closed in
  `assertNoLocalGuardianKeyOnMainnet` / `assertNoRecoveryPrivateKeyOnMainnet`).
