# Fresh Astra deployment correctness review

A fresh read-only `gpt-6-astra` review examined the owned deployment harness, bootstrap, service recovery, core raw validation, source attestation and cleanup. No implementation edits were delegated.

Confirmed findings fixed:

1. Recovery checked web/worker without repeating full Guardian health. Both restart and reset now require healthy Guardian audit, signing journal and custody.
2. Cleanup failures could leave a passed result, and the temporary Core directory was retained. Resource removal errors now fail the evidence; the owned directory is removed only after successful cleanup.
3. The added transaction verification helper called the core validator with the wrong argument order. It now passes plan, raw transaction/prevouts and pre-confirmation ledger/config and compares its returned txid to the actual submitted txid.
4. Runtime parity initially compared web only to the stored manifest. Actual Guardian files are now independently hashed too. Critical runtime entries and valid digests are mandatory; missing CRC schema marker is rejected. A failing unit test preceded implementation of the stronger attestation.

The reviewer confirmed that neutral empty-ledger bootstrap is valid: actual confirmed registration and core replay select each asset's authoritative configuration. Shared non-CRC schema differences remain outside the CRC suffix comparison.

Final recheck: **no remaining actionable findings**. Both unit tests pass. Final actual Docker evidence records launch and 500-token mint indexed at height 106, with no cleanup errors or remaining owned containers/networks. `actualExtension: false` is explicit; the real-wallet canary remains separate and open.
