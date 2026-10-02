# Fresh Astra milestone review

Reviewer: `/root/indexer_core_review`, fresh `gpt-6-astra`, high reasoning, no conversation fork.

Final verdict: no remaining covedao-ag3.6 milestone blockers.

Independently ran 12 indexer tests and 16 confirmed-core tests with owned disposable
PostgreSQL/Bitcoin Core containers. Reviewed atomic cursor/state/undo, bounded
undo/checkpoints, actual-parent failure handling, trusted registration boundary,
and durable authorization recovery. No further actionable correctness findings.

Confirmed scaling finding and fix: 500 unrelated transactions with 20 historical
authorizations improved from 5,823 ms to 27 ms. Core preparation verifies immutable
authorizations once and eligibility uses listed-outpoint lookup, preserving
cancellation and intra-block allocation creation before a later paid fill.

Guardian/API integration and unchanged-UI wallet E2E remain later gates. No
replacement deployment approval or production custody validation was claimed.
