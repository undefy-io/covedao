# Fresh Astra frontend correctness reviews

Two fresh read-only Astra reviews examined independently reconstructed browser plans, wallet adapters, the core transaction-view boundary, exact fees and arbitrary-amount presigned marketplace actions. Implementation remained with the primary agent.

The initial view review found unsigned Guardian input-0 sighash metadata mismatch, deployment creator identity incorrectly tied to a separate token account, and missing view prevout ownership/value binding. Each received failing/passing tests. View validators bind observed allocations and conserve the transaction delta; full-ledger verification remains unchanged.

The final frontend review reproduced a token carrier disguised as ordinary deployment funding, disconnect during Xverse's awaited network lookup, and launch metadata changes outside the name field. The browser now checks every final ordinary funding outpoint against all indexed token allocations/vaults, Xverse rechecks the live connection immediately after network observation, and launch binds all five normalized metadata fields at build acceptance and before signing. Regressions failed before those fixes.

The funding fix initially inherited marketplace release gating. Four failing/passing network tests now prove the read-only funding observation remains available while marketplace mutations are paused. Marketplace mutation requests still return 503 before body parsing/service construction.

Final independent disposition: no remaining confirmed blockers in the reviewed frontend scope. Astra independently ran 30/30 route/session/Xverse tests; earlier 36/36 focused tests and five desktop browser rejection reproductions passed. The original carrier-spend reproduction now refuses signing. This review does not close the separate mined browser-to-chain E2E gate.
