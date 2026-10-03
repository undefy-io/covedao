# Wallet address-index failure recovery

Manual Signet testing exposed a wallet UTXO HTTP 500. Deployed web logs recorded `TimeoutError: The operation was aborted due to timeout` from the external address index. The exact local and tunnel requests subsequently recovered to HTTP 200 without changing wallet data.

The route now maps failures inside address-cache lookup to `ADDRESS_INDEX_UNAVAILABLE`, HTTP 503, `retryable: true` and `Retry-After: 2`. The capacity error remains `ADDRESS_INDEX_BUSY`. Failed reads return before funding snapshot writes; they never claim an empty wallet or replace saved observations. Successful recovery persists the exact fresh UTXOs. Database snapshot write errors remain outside this upstream catch.

Six regression cases cover actual timeout exceptions, network errors, upstream HTTP failures, invalid provider JSON, distinct capacity failure, and successful recovery with exact amounts. Four cases fail with the original 500 before the fix. All six pass afterwards. All 210 web tests, typecheck, lint and the fresh production image build pass.

A read-only Astra review found no actionable regressions. The production Signet web/worker image was rebuilt and redeployed, with the existing database and Guardian retained. An isolated temporary container using this actual image and an unreachable local Esplora URL returns the expected retryable 503; it was removed after verification. The exact reported tunnel URL returns HTTP 200 and 26 UTXOs. [evidence.json](evidence.json) records the new image ID, public error response and summarized tunnel success.

No user-wallet transaction was signed or broadcast. The funded actual-extension canary remains open. Refresh/retry the manual wallet flow.
