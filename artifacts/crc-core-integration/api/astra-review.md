# Fresh Astra correctness reviews

Read-only `gpt-6-astra`, high reasoning, fresh-context reviews covered shared core events/DTOs, wallet-first/server signing adapters, API quotes/reads/builds/funding/sessions/submit/market services, fresh schema and rollback behavior.

`api_foundation_review` independently passed initial owned HTTP/PG tests, core DTO/event/vault tests, and all 18 adapters. It identified the cached Guardian wallet-witness retry issue. After the regression/fix, it independently passed all five then-current HTTP/Core tests and confirmed the finding resolved.

`api_final_review` independently reproduced expired-claim hash binding and build replay after funding-cache removal using disposable PostgreSQL. Both were fixed following failing tests. It independently verified new claim UUID recovery, live lease exclusion, stale completion/release fences, exact build replay after funding removal, and changed-request conflicts.

The final follow-up independently passed all 13 HTTP/Core integration tests (`review-http-recovery.log`) and checked frozen fee-rate replay: the existing launch retains rate 2 and its exact response after funding removal; changing the tier conflicts; a new key uses fresh rate 5. No additional blockers were found in full signing verification, Guardian witness merging, market authorization/fill/cancellation, funding exclusion, or event rollback/checkpoint paths. Reviewers made no implementation edits.

This is source/API milestone evidence. The unchanged frontend integration and live-wallet rollout gates remain separate and unverified here.
