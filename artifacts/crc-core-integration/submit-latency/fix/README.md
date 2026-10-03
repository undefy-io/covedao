# CRC submission latency fix

Beads task `covedao-jkr` implements the findings in [the diagnosis](../README.md).

The limiter now gives unused request quota to waiting services, choosing the oldest-served eligible lane and FIFO within it. The shared upstream cap stays3requests/second. Reserved concurrent slots still prevent stalled public RPCs from blocking worker/Guardian. Waiting requests have bounded expiry and cancellation cleanup; existing JSON budget rows require no migration.

Fresh submit retains wallet/core verification and live network/canonical-chain/input checks before signing and after Guardian signing. It persists the exact signed bytes as READY before broadcast, then calls mempool acceptance/broadcast directly. Recovery retains observation, reconstruction and current-state checks; retries reuse the saved bytes and never request new custody. Network proof is scoped to the current request instead of issuing redundant network calls during its broadcast phase.

Guardian removes one duplicate preclaim live pass; it checks current state/inputs immediately before custody and again afterward. Reused journal signatures still require a fresh live pass. A stale pre-custody failure now records and releases its claimed journal row. The regression checks that exact row instead of assuming the fixture DB contains only one failed request.

Successful/error submit responses expose `Server-Timing` with total submit duration and, where applicable, live-before-sign, Guardian, live-before-broadcast and broadcast durations. Labels/durations contain no wallet or transaction material.

## Measurements

`latency-red.json` demonstrates the old behavior through actual Bitcoin Core/PostgreSQL/HTTP Guardian and independent wallet signatures at the real default3/s scheduler, with a modeled200ms transport delay per high-level RPC. The original fresh sell took34.252seconds and34high-level calls (the observation helper represents two physical RPCs, hence35physical calls).

`latency-green.json` records the same three-input700-token sell in8.591seconds and22calls, retaining12UTXOchecks at the four live fences. The latest full suite measurement replaces the earlier focused8.897second run. Calls drop to12web+10Guardian, and fresh submit makes no pre-broadcast transaction observation. The modeled-delay measurement is not a promised live user-request duration; worker traffic and upstream latency still contribute.

## Validation

- Three owned real-PostgreSQL scheduler tests: idle quota reuse at the shared cap, public-replica flooding with prompt worker/Guardian service, stalled-call concurrency and aborted-waiter cleanup/configuration mismatch.
- All17realCore/PostgreSQL/HTTPGuardian API integration tests, including wrong network, changed signatures, stale inputs, competing buys, same-height reorg/replacement, lost Guardian response, persisted READY/failed-broadcast recovery and saved receipt retry.
- Workspace typecheck/lint/test and standalone Guardian install/typecheck/lint/test pass. Existing unrelated skips remain recorded. Core protocol/economics/wire formats and UI controls are unchanged.
- Independently built app/standalone Guardian production images pass all7owned regtest lifecycle checks, including inventory-first purchase, follow-on purchase, restart preservation and22runtime source hashes (including the shared scheduler).
- The canonical sync script now copies/attests the shared RPC scheduler alongside CRC sources, avoiding a standalone Guardian fork.

## Deployment

Upgrade completed: web/worker image `fd973b1f`, standalone Guardian `41a43812`. All22runtime files match including the scheduler, and readiness/health pass. Current ASDF state, five events and one registration are preserved. The read-only public-lane probes under live worker traffic take0.44–0.90seconds after the fix; original later probes took1.06–1.18seconds. New unknown-session submit requests return400 with a measured `Server-Timing` header without contacting custody or broadcasting.

The selected Signet rollout preserves current ASDF assets, history and registrations. DB/profile backups are gitignored under `.local/signet-backups/latency-jkr/`; prior images are retained with `:pre-latency-jkr` tags. No database reset, RPC-rate increase or user-wallet signing/broadcast occurs during this fix. `signet-rollout.json` and `rpc-probe-after.json` record deployed service/source/state checks and read-only timing probes.

The user can test a new sell at localhost:3000 or the existing tunnel. Browser Network response headers now expose `Server-Timing` to distinguish Guardian, live checks and broadcast. Actual new user-wallet submission latency is a manual canary; the agent does not replay a signed user transaction to obtain a faster sample.
