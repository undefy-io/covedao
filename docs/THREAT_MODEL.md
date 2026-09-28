# Cove V3 Threat Model (mainnet)

Bitcoin enforces UTXO spending/signatures/value conservation/double-spend.
Cove clients/indexer validate token lineage + supply/backing. The Guardian
pre-executes Simplicity + reference policy. Bitcoin does NOT execute Simplicity;
the Guardian remains a trust/liveness boundary. Recovery is delayed emergency
authority.

| Actor / failure | Prevention | Detection | Recovery / residual |
|---|---|---|---|
| Malicious web/API | no keys in web; remote signer revalidates; caps at signer | audit, alerts | read-only safe; fails closed |
| Malicious user | signatures; indexer/Core revalidation | mempool/conflict | rejection |
| Compromised Guardian key | isolated custody; signer validation and caps while uncompromised | invalid state/signature alerts; durable audit | a stolen key can bypass validation; emergency recovery (threshold) |
| Dead Guardian | liveness noted publicly | heartbeat | recovery path |
| 1/3 recovery key lost | 2-of-3 threshold | — | still operable |
| 2/3 recovery compromised | threshold | — | documented residual risk (delayed authority) |
| DB corruption/loss | rebuildable chain + backups; journal survives | invariant monitors | restore + verify root |
| Core disagreement | primary+secondary quorum | CORE_DIVERGED alert | mutations halt |
| Reorg (deep) | deterministic reconcile; threshold | reorg alert | operator review |
| Stale quote/indexer | state binding; health gate | QUOTE_STALE | refresh |
| Dependency compromise | pinned builds, SBOM, vuln audit | CI | rollback |

See `docs/runbooks/` for per-incident procedures.
