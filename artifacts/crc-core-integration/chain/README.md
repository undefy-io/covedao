# Owned browser-to-chain release gate

Run from the repository root:

```sh
CRC_CORE_CHAIN_EVIDENCE_PATH=/tmp/crc-chain-evidence.json pnpm --filter @crclaunch/web test:e2e:crc-chain
```

The gate creates UUID-owned Bitcoin Core 30 regtest and PostgreSQL containers,
a production Next build/start on an ephemeral port, an independent Guardian
signing service behind authenticated HTTP, and the production CRC indexer.
The app source copy is byte-checked and SHA256-recorded. Workspace packages,
protocol configuration, database migrations and HTTP routes are the current
canonical implementations. Node fee observations refresh at worker checkpoints.
Cleanup stops only the processes and containers created by this harness.

The wallet provider is **simulated**, using public test keys confined to the
Node test process. The browser receives public account metadata and PSBT/BIP322
responses. It uses the existing wallet adapter, independent browser review,
core builders and response verification. Native SegWit and nested SegWit payment
accounts plus a distinct Taproot token account are exercised. This does not
claim an actual extension spend or a standalone Guardian process startup.

The unchanged launch, trade, seller and buyer controls exercise deployment,
500+500 mint, 400+600 sell, inventory buy, 1,000 sell, 500/1,500 whole-output
offers, buyer-only purchases, a fractional Taproot offer and ALL cancellation.
Transfer and on-chain listing/split have no baseline form; the gate invokes the
same independently verifying browser service for those operations.

Every mined transaction is validated against its stored core plan using actual
raw bytes and prevouts. Its observed block is independently replayed through
the authoritative core, then compared with indexer state and the persisted
database root. Evidence retains exact plans, raw transactions, snapshots,
session receipts, public wallet responses and custody call counts.

The remaining cases verify competing advisory builds with one winner and no
second custody call, an already reviewed paid presign settling after advisory
expiry while fresh expired construction refuses, app restart and persisted
receipt replay, actual chain rollback/rebroadcast with identical economic state,
and PSBT/token-funding/forged-terms/re-signed-wrong-presign rejection.

Three implementation regressions were reproduced before fixes: JSONB reordered
object keys caused false browser plan mismatches, and BIP174 finalization removed
nested redeemScript metadata that subsequent server verification rejected.
Object-key ordering is now ignored while arrays and marker string bytes remain
exact. Omitted signing metadata is accepted only for finalized wallet inputs;
nested scriptSig must push the original redeem script, and core verifies the
full spend. Changed metadata and fixed seller witnesses remain protected.
Fresh expired-offer construction also surfaced as an uncoded server error;
the adapter now maps the core's exact refusal to STATE_CHANGED without checking
or duplicating expiry rules. Existing paid presigns retain core settlement rules.

The frontend milestone's [pixel/control parity evidence](../frontend/README.md)
remains the visual baseline. No component markup, layout, styling or control is
changed by this gate. No user funds, mainnet enablement, existing deployment
modification or actual-wallet canary is claimed.

Workspace tests and builds also run with Turbo package concurrency one. A
concurrent run timed out loading a web unit fixture; the complete serial test
gate passed. Concurrent standalone/web documentation builds share Docusaurus
state and reported broken links; the complete serial build passed. Follow-up
`covedao-3xw` tracks that shared build ordering issue.

Final results: **7/7** actual-chain browser cases, **17 unique mined
transactions** (18 raw/state checks including identical cancellation
rebroadcast), **28 wallet prompts**, **9 custody signatures**, and **218**
byte-verified copied app source files. Every independent core root matched
indexer/persisted state. [Evidence JSON](evidence.json) retains these records;
[release log](logs/verified.log) records the complete run.

The full workspace test gate passed 52/52 tasks, including core147/147 plus all
1,950 read-only SQLite comparisons, adapters19/19 and web233 with eight existing
skips. Workspace typecheck/lint passed53/53 tasks each; build passed30/30.
Standalone Guardian39 managed files matched canonical sources and its required
install/Rust/build/typecheck/lint/test gates passed30 tests with14 environment
skips. Its preexisting user README hash remains unchanged.
