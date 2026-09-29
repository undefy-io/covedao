import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { saveWalletFundingSnapshot, walletFundingSnapshot } from "./wallet-funding.js";
import { schema } from "./client.js";
import {
  backingObservationBase,
  claimObservationWorker,
  publishBackingObservation,
  effectiveBackingObservation,
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
  expect((await effectiveBackingObservation(db!, network, tokenId))?.payload.txid).toBe(parent);
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

  it("keeps cached reads available across a reorg while rejecting obsolete worker writes", async () => {
    const { base, epoch } = await fixture();
    await db!.execute(sql`update cove_v3_cursor set block_hash = 'replacement' where network = ${network}`);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.payload.txid).toBe(parent);
    await db!.execute(sql`update cove_v3_cursor set block_hash = ${hash} where network = ${network}`);
    expect(await publishBackingObservation(db!, base, epoch, base.backing, new Date())).toBe(false);
    const current = (await backingObservationBase(db!, network, tokenId))!;
    expect(await publishBackingObservation(db!, current, epoch, current.backing, new Date())).toBe(true);
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

  it("does not invalidate the cache when a submission is prepared, signed or accepted", async () => {
    const { base, epoch } = await fixture();
    const before = await db!.execute(sql`select pending_revision from cove_observation_epochs where network = ${network}`);
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
    expect((await effectiveBackingObservation(db!, network, tokenId))?.payload.txid).toBe(parent);
    await db!.execute(sql`insert into cove_v3_signing_journal
      (network, backing_txid, backing_vout, unsigned_tx_digest, expires_at)
      values (${network}, ${parent}, 1, 'digest', clock_timestamp() + interval '1 minute')`);
    await db!.execute(sql`update cove_v3_signing_journal set signed_at = clock_timestamp(),
      signing_result = jsonb_build_object('resultJson', ${JSON.stringify({ tokenId })}::text)
      where network = ${network} and unsigned_tx_digest = 'digest'`);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.payload.txid).toBe(parent);
    await db!.execute(sql`update cove_v3_submissions set raw_tx_hex = 'signed', txid = 'signed', phase = 'READY'
      where id = ${submission!.id}`);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.payload.txid).toBe(parent);
    expect(await publishBackingObservation(db!, base, epoch, base.backing, new Date())).toBe(true);
    await db!.execute(sql`update cove_v3_submissions set accepted_at = clock_timestamp(), phase = 'BROADCAST'
      where id = ${submission!.id}`);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.payload.txid).toBe(parent);
    expect((await backingObservationBase(db!, network, tokenId))?.revision).toBe(base.revision);
    expect(await publishBackingObservation(db!, base, epoch, base.backing, new Date())).toBe(true);
    const after = await db!.execute(sql`select pending_revision from cove_observation_epochs where network = ${network}`);
    expect(after.rows).toEqual(before.rows);
    const current = (await backingObservationBase(db!, network, tokenId))!;
    expect(await publishBackingObservation(db!, current, epoch, current.backing, new Date())).toBe(
      true,
    );
  });

  it("retains the last good pending cache when RPC observation fails", async () => {
    const { base, epoch } = await fixture();
    const pending = { ...base.backing, txid: "pending", stateHash: "pending", issuedSupplyAtoms: "100000000000" };
    expect(await publishBackingObservation(db!, base, epoch, pending, new Date(Date.now() - 60_000))).toBe(true);
    expect(await publishBackingObservation(db!, base, epoch, null, new Date())).toBe(true);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.payload).toEqual(pending);
  });
  it("keeps the cache available for competing signers and acceptance racing a refresh", async () => {
    const { base, epoch } = await fixture();
    const submissions = await Promise.all(Array.from({ length: 32 }, async (_, i) => {
      const [submission] = await db!.insert(schema.coveV3Submissions).values({
        network, sourceKind: "APP", sourceId: randomUUID(), operation: "BACKING_BUY",
        tokenId, backingTxid: parent, backingVout: 1, unsignedTxDigest: `competitor-${i}`,
        walletPsbtBase64: "fixture", rawTxHex: `raw-${i}`, txid: `tx-${i}`, phase: "READY",
      }).returning();
      return submission!;
    }));
    expect((await effectiveBackingObservation(db!, network, tokenId))?.payload.txid).toBe(parent);
    expect((await backingObservationBase(db!, network, tokenId))?.revision).toBe(base.revision);
    await Promise.all([
      publishBackingObservation(db!, base, epoch, base.backing, new Date()),
      db!.execute(sql`update cove_v3_submissions set accepted_at = clock_timestamp(), phase = 'BROADCAST'
        where id = ${submissions[31]!.id}`),
    ]);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.payload.txid).toBe(parent);
    expect((await backingObservationBase(db!, network, tokenId))?.revision).toBe(base.revision);
    expect(await publishBackingObservation(db!, base, epoch, base.backing, new Date())).toBe(true);
  });

  it.each([
    "update cove_pending_backing set observed_revision = null",
    "update cove_pending_backing set observed_at = clock_timestamp() - interval '1 hour'",
    "update cove_pending_backing set requested_revision = requested_revision + 1",
    "update cove_v3_runtime set core_reachable = false",
    "update cove_v3_runtime set chain_observed_at = clock_timestamp() - interval '1 hour'",
    "update cove_v3_runtime set core_tip = 'other'",
    "update cove_v3_cursor set rebuilding = true",
  ])("serves cached backing independently of freshness: %s", async (update) => {
    const { base, epoch } = await fixture();
    const pending = { ...base.backing, txid: "pending", stateHash: "pending" };
    await publishBackingObservation(db!, base, epoch, pending, new Date());
    await db!.execute(sql`${sql.raw(update)} where network = ${network}`);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.payload).toEqual(pending);
  });

  it.each([
    "delete from cove_pending_backing",
    "update cove_pending_backing set payload = null",
    "update cove_pending_backing set base_txid = 'obsolete'",
  ])("uses indexed backing when no applicable pending cache exists: %s", async (update) => {
    const { base, epoch } = await fixture();
    await publishBackingObservation(db!, base, epoch, { ...base.backing, txid: "pending" }, new Date());
    await db!.execute(sql`${sql.raw(update)} where network = ${network}`);
    expect((await effectiveBackingObservation(db!, network, tokenId))?.payload).toEqual(base.backing);
  });

  it("scopes funding by network/script, bounds snapshots and replaces emptied wallets", async () => {
    const coins = Array.from({ length: 300 }, (_, n) => ({
      txid: n.toString(16).padStart(64, "0"),
      vout: 0,
      valueSats: String(1000 + n),
      confirmations: n % 2,
    }));
    await saveWalletFundingSnapshot(db!, network, "0014aa", coins);
    const snapshot = (await walletFundingSnapshot(db!, network, "0014aa"))!;
    expect(snapshot).toHaveLength(256);
    expect(snapshot.slice(0, 150).every((coin) => coin.confirmations === 1)).toBe(true);
    expect(snapshot[0]?.valueSats).toBe("1299");
    expect(await walletFundingSnapshot(db!, network + "other", "0014aa")).toBeUndefined();
    expect(await walletFundingSnapshot(db!, network, "0014bb")).toBeUndefined();
    await saveWalletFundingSnapshot(db!, network, "0014aa", []);
    expect(await walletFundingSnapshot(db!, network, "0014aa")).toEqual([]);
  });

  it("returns no backing for a missing token", async () => {
    expect(await effectiveBackingObservation(db!, network, "missing")).toBeNull();
  });
});
