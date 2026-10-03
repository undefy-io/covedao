# Fresh Astra cleanup review

A fresh read-only `gpt-6-astra` review inspected root and standalone Guardian cleanup diffs, reset/schema ancestry, retained tables, wallet funding/account behavior and active entrypoints.

Confirmed findings fixed with failing/passing checks:

1. Default worker/health probes and product CI still targeted removed V3 routes. Default runtime now selects CRC, web probes the CRC catalog, and the owned CRC lifecycle replaces obsolete product E2E.
2. A heartbeat written before ownership and keyed only by network could overwrite another worker's readiness. Initial write follows ownership acquisition; database identity/network scope and dead/stale/failure checks are shared with the probe.
3. Signet instructions incorrectly merged regtest Compose environment; current README explicitly uses the standalone Signet configuration.
4. Regtest examples lacked coordinated CRC activation and Guardian credentials; examples and local-only Compose are aligned.
5. Two executable web probes still called removed APIs; scripts and exposed command are retired, historical evidence remains.
6. Direct fresh CI/host execution imported unbuilt core exports; explicit runtime build prerequisites are added. Actual fresh Docker builds additionally exposed missing adapter output and copied incremental caches; both runtime packages build from a clean context.

The reviewer confirmed removal snapshot ancestry and unchanged retained table definitions, and found no remaining confirmed reset, wallet-funding or Guardian runtime regression. Actual-extension canary remains unverified.

Final recheck reports **no remaining confirmed findings** and confirms successful fresh app image creation.
