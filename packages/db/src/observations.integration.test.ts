import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { schema } from "./client.js";
import {
  backingObservationBase,
  claimObservationWorker,
  publishBackingObservation,
  effectiveBackingObservation,
  acceptedObservationCandidate,
  publishAcceptedObservation,
} from "./observations.js";

const url = process.env.SUBMISSION_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated =
  parsed?.hostname === "127.0.0.1" &&
  parsed.port === "5435" &&
  parsed.pathname === "/submissions_test";
const pool = isolated ? new Pool({ connectionString: url }) : undefined;
const db = pool ? drizzle(pool, { schema }) : undefined;
let network: string;
const tokenId = "11".repeat(32),
  parent = "22".repeat(32),
  hash = "33".repeat(32);

async function fixture() {
  const epoch = await claimObservationWorker(db!, network);
  const base = (await backingObservationBase(db!, network, tokenId))!;
  expect(await publishBackingObservation(db!, base, epoch, base.backing, new Date())).toBe(true);
  expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(true);
  return { epoch, base };
}

describe.skipIf(!isolated)("fenced worker observations on isolated PostgreSQL", () => {
  beforeAll(async () =>
    migrate(db!, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) }),
  );
  beforeEach(async () => {
    network = `observations-${randomUUID()}`;
    await db!
      .insert(schema.coveV3Cursor)
      .values({ network, height: 101n, blockHash: hash, stateRoot: "root", rebuilding: false });
    await db!
      .insert(schema.coveV3Tokens)
      .values({
        network,
        tokenId,
        ticker: "TEST",
        nonce: "nonce",
        policyVersion: 3,
        deployTxid: parent,
        deployHeight: 100n,
        deployBlockHash: hash,
      });
    await db!
      .insert(schema.coveV3BackingStates)
      .values({
        network,
        tokenId,
        stateHash: "state",
        stateVersion: 2,
        policyVersion: 3,
        issuedSupplyAtoms: 0n,
        backingSats: 0n,
        curveStage: 0,
        txid: parent,
        vout: 1,
        scriptPubKey: "51",
        btcValue: 10000n,
        blockHeight: 100n,
        blockHash: hash,
      });
    await db!
      .insert(schema.coveV3Runtime)
      .values({
        network,
        coreHeight: 101n,
        coreTip: hash,
        coreReachable: true,
        chainObservedAt: new Date(),
      });
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("invalidates a projection in the same commit as an equal-height reorg, including return to the old hash", async () => {
    const { base, epoch } = await fixture();
    await db!.execute(
      sql`update cove_v3_cursor set block_hash = 'replacement' where network = ${network}`,
    );
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(false);
    await db!.execute(
      sql`update cove_v3_cursor set block_hash = ${hash} where network = ${network}`,
    );
    expect(await publishBackingObservation(db!, base, epoch, base.backing, new Date())).toBe(false);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(false);
    const current = (await backingObservationBase(db!, network, tokenId))!;
    expect(await publishBackingObservation(db!, current, epoch, current.backing, new Date())).toBe(
      true,
    );
  });

  it("fences an in-flight older worker after a replacement claims ownership", async () => {
    const { base, epoch } = await fixture();
    const replacement = await claimObservationWorker(db!, network);
    await expect(
      publishBackingObservation(db!, base, epoch, base.backing, new Date()),
    ).rejects.toMatchObject({ name: "WorkerOwnershipLost" });
    expect(await publishBackingObservation(db!, base, replacement, base.backing, new Date())).toBe(
      true,
    );
  });

  it("keeps fresh quotes while a submission is prepared and signed, then fences acceptance", async () => {
    const { base, epoch } = await fixture();
    const [submission] = await db!
      .insert(schema.coveV3Submissions)
      .values({
        network,
        sourceKind: "APP",
        sourceId: randomUUID(),
        operation: "BACKING_BUY",
        tokenId,
        backingTxid: parent,
        backingVout: 1,
        unsignedTxDigest: "digest",
        walletPsbtBase64: "fixture",
      }).returning();
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(true);
    await db!.execute(sql`insert into cove_v3_signing_journal
      (network, backing_txid, backing_vout, unsigned_tx_digest, expires_at)
      values (${network}, ${parent}, 1, 'digest', clock_timestamp() + interval '1 minute')`);
    await db!.execute(sql`update cove_v3_signing_journal set signed_at = clock_timestamp(),
      signing_result = jsonb_build_object('resultJson', ${JSON.stringify({ tokenId })}::text)
      where network = ${network} and unsigned_tx_digest = 'digest'`);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(true);
    await db!.execute(sql`update cove_v3_submissions set raw_tx_hex = 'signed', txid = 'signed', phase = 'READY'
      where id = ${submission!.id}`);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(true);
    expect(await publishBackingObservation(db!, base, epoch, base.backing, new Date())).toBe(true);
    await db!.execute(sql`update cove_v3_submissions set accepted_at = clock_timestamp(), phase = 'BROADCAST'
      where id = ${submission!.id}`);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(false);
    expect(await publishBackingObservation(db!, base, epoch, base.backing, new Date())).toBe(false);
    const current = (await backingObservationBase(db!, network, tokenId))!;
    expect(await publishBackingObservation(db!, current, epoch, current.backing, new Date())).toBe(
      true,
    );
  });

  it("rejects stale, unavailable, lagging and rebuilding observations without RPC fallback", async () => {
    const { base, epoch } = await fixture();
    expect(
      await publishBackingObservation(
        db!,
        base,
        epoch,
        base.backing,
        new Date(Date.now() - 16_000),
      ),
    ).toBe(true);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(false);
    expect(await publishBackingObservation(db!, base, epoch, null, new Date())).toBe(true);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(false);
    expect(await publishBackingObservation(db!, base, epoch, base.backing, new Date())).toBe(true);
    await db!.execute(sql`update cove_v3_runtime set core_height = 102 where network = ${network}`);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(false);
    await db!.execute(sql`update cove_v3_cursor set rebuilding = true where network = ${network}`);
    expect(await publishBackingObservation(db!, base, epoch, base.backing, new Date())).toBe(false);
  });
  it("keeps quotes available for competing signers and fences a racing refresh on acceptance", async () => {
    const { base, epoch } = await fixture();
    const submissions = await Promise.all(Array.from({ length: 32 }, async (_, i) => {
      const [submission] = await db!.insert(schema.coveV3Submissions).values({
        network, sourceKind: "APP", sourceId: randomUUID(), operation: "BACKING_BUY",
        tokenId, backingTxid: parent, backingVout: 1, unsignedTxDigest: `competitor-${i}`,
        walletPsbtBase64: "fixture", rawTxHex: `raw-${i}`, txid: `tx-${i}`, phase: "READY",
      }).returning();
      return submission!;
    }));
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(true);
    expect((await backingObservationBase(db!, network, tokenId))?.revision).toBe(base.revision);
    await Promise.all([
      publishBackingObservation(db!, base, epoch, base.backing, new Date()),
      db!.execute(sql`update cove_v3_submissions set accepted_at = clock_timestamp(), phase = 'BROADCAST'
        where id = ${submissions[31]!.id}`),
    ]);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(false);
    expect(await publishBackingObservation(db!, base, epoch, base.backing, new Date())).toBe(false);
  });

  it.each([
    ["pending_revision_changed", "update cove_pending_backing set observed_revision = null"],
    ["backing_observation_expired", "update cove_pending_backing set observed_at = clock_timestamp() - interval '16 seconds'"],
    ["chain_generation_changed", "update cove_pending_backing set chain_generation = chain_generation - 1"],
    ["canonical_backing_changed", "update cove_pending_backing set base_txid = 'older'"],
    ["backing_proof_unavailable", "update cove_pending_backing set payload = null"],
    ["core_unreachable", "update cove_v3_runtime set core_reachable = false"],
    ["chain_observation_expired", "update cove_v3_runtime set chain_observed_at = clock_timestamp() - interval '31 seconds'"],
    ["indexer_tip_changed", "update cove_v3_runtime set core_tip = 'other'"],
    ["indexer_rebuilding", "update cove_v3_cursor set rebuilding = true"],
  ])("diagnoses unavailable quotes: %s", async (reason, update) => {
    await fixture();
    await db!.execute(sql`${sql.raw(update)} where network = ${network}`);
    const observation = await effectiveBackingObservation(db!, network, tokenId);
    expect(observation?.fresh).toBe(false);
    expect(observation?.unavailableReason).toBe(reason);
  });
  it("advances two accepted buys immediately and cannot overwrite a newer broadcast or generation", async () => {
    const { epoch } = await fixture();
    const firstId = randomUUID();
    await db!
      .insert(schema.coveV3Submissions)
      .values({
        id: firstId,
        network,
        sourceKind: "APP",
        sourceId: randomUUID(),
        operation: "BACKING_BUY",
        tokenId,
        backingTxid: parent,
        backingVout: 1,
        unsignedTxDigest: "first",
        walletPsbtBase64: "fixture",
        txid: "first",
        rawTxHex: "first",
        phase: "READY",
      });
    const first = (await acceptedObservationCandidate(db!, network, tokenId))!;
    await db!.execute(
      sql`update cove_v3_submissions set accepted_at = clock_timestamp(), phase = 'BROADCAST' where id = ${firstId}`,
    );
    const one = {
      ...first.payload,
      txid: "first",
      stateHash: "first",
      issuedSupplyAtoms: "100000000000",
    };
    expect(
      await publishAcceptedObservation(db!, first.base, firstId, { txid: parent, vout: 1 }, one),
    ).toBe(true);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.payload?.txid).toBe("first");
    const olderRefresh = (await backingObservationBase(db!, network, tokenId))!;
    const secondId = randomUUID();
    await db!
      .insert(schema.coveV3Submissions)
      .values({
        id: secondId,
        network,
        sourceKind: "APP",
        sourceId: randomUUID(),
        operation: "BACKING_BUY",
        tokenId,
        backingTxid: "first",
        backingVout: 1,
        unsignedTxDigest: "second",
        walletPsbtBase64: "fixture",
        txid: "second",
        rawTxHex: "second",
        phase: "READY",
      });
    const second = (await acceptedObservationCandidate(db!, network, tokenId))!;
    await db!.execute(
      sql`update cove_v3_submissions set accepted_at = clock_timestamp(), phase = 'BROADCAST' where id = ${secondId}`,
    );
    const two = { ...one, txid: "second", stateHash: "second", issuedSupplyAtoms: "200000000000" };
    expect(
      await publishAcceptedObservation(db!, second.base, secondId, { txid: "first", vout: 1 }, two),
    ).toBe(true);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.fresh).toBe(true);
    expect(
      await publishBackingObservation(db!, olderRefresh, epoch, olderRefresh.backing, new Date()),
    ).toBe(false);
    expect(
      await publishAcceptedObservation(db!, first.base, firstId, { txid: parent, vout: 1 }, one),
    ).toBe(false);
    await db!.execute(
      sql`update cove_v3_cursor set block_hash = 'reorg' where network = ${network}`,
    );
    await db!.execute(
      sql`update cove_v3_cursor set block_hash = ${hash} where network = ${network}`,
    );
    expect(
      await publishAcceptedObservation(db!, second.base, secondId, { txid: "first", vout: 1 }, two),
    ).toBe(false);
  });
});
