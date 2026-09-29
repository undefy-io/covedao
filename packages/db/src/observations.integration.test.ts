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

  it("does not overwrite a signature or submission notification with an older refresh", async () => {
    const { base, epoch } = await fixture();
    await db!
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
      });
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
