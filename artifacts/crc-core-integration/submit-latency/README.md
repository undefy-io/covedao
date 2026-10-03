# Successful Signet sell submission latency

Diagnosis: `covedao-6oo`; optimization follow-up: `covedao-jkr`.

The reported tunnel sell submission succeeded: latest 700-token sell session `6c4743e5-e9f5-478e-a9b7-f1a9b39e8e34` is BROADCAST, txid `220fc5f5931f2fb44a6ee5544e10317c52cfcddc5b5577459f16a10aaa5b81ce`. [latest-sell.json](latest-sell.json) records three inputs, 31.718 seconds from backend claim to completion, and 5.747 seconds from web claim to Guardian claim. These timestamps are partway through the endpoint: initial wallet verification and live checks occur before claim. Build-to-completion includes wallet review time and is not submit latency.

No per-stage request trace was enabled for the original request. Web/Guardian logs contain no successful-request timing. The exact historical 36-second breakdown cannot be reconstructed; the source path and live measurements identify a strong explanation.

The deployed configuration defaults to three RPC requests per second. `PostgresRpcBudget` splits that into fixed worker/Guardian/public lanes by setting each lane's next grant to `now + ceil(3000/rate)`: at rate3, each lane waits one second between request starts even when others are idle. Independent requests also share the global budget. [rpc-probe.json](rpc-probe.json) measures four sequential read-only `getblockchaininfo` calls from the deployed web image, separating budget acquisition from HTTP transport. HTTP replies are approximately 200ms; later calls wait approximately 800–960ms for quota. No upstream HTTP429 occurred in these probes. Each total call therefore takes around one second.

For the successful fresh path with three transaction inputs and one unique deployment parent, the code performs approximately35 serial RPC calls:

| Stage | RPC calls |
| --- | ---: |
| Web initial network/canonical/input checks | 5 |
| Guardian network + archived deployment parent + three canonical/input checks | 14 |
| Web after Guardian canonical/network/input checks | 5 |
| Fresh READY handling: network + transaction observation + canonical/network/input checks + recorded broadcast network/accept/send | 11 |
| Total | 35 |

The count describes the nominal current source path, not an instrumented historical trace; retries or concurrent worker traffic can add time. The web uses21 public-lane calls and Guardian14 Guardian-lane calls. Awaiting these sequential stages means their lane waits accumulate. This accounts for a roughly36-second successful submit, without waiting for block confirmation. The tunnel is not the sole cause because31.7 seconds elapse between server-side DB timestamps alone.

Relevant source: `apps/web/src/lib/crc-submit.ts` (`assertLive`, `submitCrcSession`, `broadcastReady`); `packages/crc20-guardian/src/index.ts` (`signChecked`); `packages/bitcoin/src/recorded-broadcast.ts`; `packages/db/src/quotas.ts` (`PostgresRpcBudget.acquireShared`). Runtime remains the previously tested `27e1ca7` integration with aligned standalone Guardian.

The follow-up should remove repeated work at safe boundaries, separate fresh-submit broadcast from crash-recovery checks, reuse request-scoped network proof, consider immutable content-addressed registration verification, and evaluate work-conserving lane grants while retaining the upstream total cap and service fairness. Preserve post-sign/current-input checks, race/reorg rejection and persisted READY idempotency. Add stage/budget/transport timing and meaningful Core concurrency/retry tests before release. Simply raising the provider budget or replacing live checks with stale cached UTXOs would not address those correctness requirements.

This investigation uses DB queries and four read-only RPC probes only. It neither replays the signed user request nor signs/broadcasts any transaction, resets data, changes budget configuration or restarts services. No production code changes were made.
