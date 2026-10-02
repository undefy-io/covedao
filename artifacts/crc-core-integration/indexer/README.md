# Fresh shared-core indexer evidence

All Bitcoin and PostgreSQL mutations in these tests use disposable containers owned
by the test suite. No application database, public chain, user wallet or funded
wallet was used. Native vault keys here are public test fixtures; production
Guardian custody remains a separate dependent integration gate.

The failing-first logs capture the missing observation/store functions, the old
runner ignoring the new registry, authorization rehydration failing before an
intra-block paid fill, and repeated signature verification. `registration-red.log`
captures the absent new registry API. The runner was subsequently replaced;
`indexer-green.log` records 89 passing package tests with one unrelated V3 database
suite skipped, including all 12 CRC cases.

`mined-indexer.json` contains the actual signed deploy/mint/burn/fill bytes and
core plans, signed offer terms, exact amounts/outputs, same-height hashes and deep
reorg replay counts. Deploy, mint and fill each use exactly 1,000 sats miner fee;
Bitcoin Core accepts/mines them, and core validation checks the signed plans.
The burn is a real 500-sat non-protocol spend of a 1,000-sat carrier. An unregistered
external deployment is mined but excluded from CRC assets and allocations.

Persistence cases prove empty-block idempotence, JSON hydration/restart equality,
real PostgreSQL trigger failure rolling back records/cursor/undo, parent RPC
failure leaving durable state unchanged, and bounded undo/checkpoints. Core state
is compared directly with database hydration. Actual shallow/same-height and deep
reorgs retire/restore offers and allocations; separately durable signed terms and
cancellation survive checkpoint recovery. Confirmed payment settles a previously
cancel-requested offer from its signed terms.

Fresh Astra independently passed 12 indexer and 16 confirmed-core tests. It found
repeated historical authorization verification, then verified the fix: a benchmark
of 500 unrelated transactions and 20 historical authorizations improved from
5,823 ms to 27 ms. The checked regression reduces BIP322 verification from 22 calls
to one for one authorization in a 20-transaction block.

The migration was applied against the full existing migration history in a fresh
disposable database. It only creates the eight new `crc_*` tables and their indexes;
it does not reset or migrate existing application data. No replacement deployment
or frontend E2E gate is claimed by this milestone.
