# Fresh Astra correctness review

A fresh `gpt-6-astra` agent reviewed the owned chain harness and implementation
fixes read-only, followed by scoped rechecks after confirmed changes. No
implementation was delegated.

The review found no product blocker in the JSONB semantic comparison or the
BIP174 finalized nested metadata exception. It identified these test gaps:

- Raw seller witnesses were compared as bytes against hex strings. Normalize
  actual witnesses to hex before exact equality. The observed purchase had
  already mined successfully.
- Re-mined cancellation originally checked only offer status. Compare the
  complete economic snapshot, excluding the replaced tip, and retain roots.
- Indexer output originally matched only a reread of its own database. Replay
  the actual observed block independently through core, including coinbase and
  raw parents for the exact observation fingerprint, and compare full roots.
- Add actual browser/HTTP tampering, token funding, forged terms and a validly
  re-signed wrong seller presign. Verify no extra prompts or custody calls.

All four gaps were addressed. The reviewer rechecked the independent oracle,
actual fee observation refresh and copied app source hashes and found no
correctness blocker. Hash coverage is scoped to `apps/web/src`, not all workspace
dependencies/configuration.

The actual chain run then exposed the generic expired-offer API error. A failing
service integration regression preceded mapping the core's exact refusal to
STATE_CHANGED. Astra found no blocker in that mapping: construction still uses
the core rule, saved-session replay still happens first, and paid delayed
submission keeps its original settlement semantics. The HTTP test additionally
requires status 400 and STATE_CHANGED.

The review explicitly distinguishes the simulated wallet, shared production
Guardian signing service with test custody, and browser-service transfer/split
tests from an actual extension spend or standalone Guardian process startup.
Final execution results are recorded separately in the release log/evidence.
