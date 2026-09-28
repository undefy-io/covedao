import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { schema } from "./client.js";
import { prepareSubmission, claimSubmission, saveSignedSubmission, publishSubmission, deferSubmission, getSubmission, dueSubmissions, haltSubmission, resumeSubmission, type SubmissionInput } from "./submissions.js";

const url = process.env.SUBMISSION_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/submissions_test";
const pool = isolated ? new Pool({ connectionString: url }) : undefined;
const db = pool ? drizzle(pool, { schema }) : undefined;
const network = "recovery-fixture";
const digest = "ab".repeat(32);
const txid = "cd".repeat(32);

async function appInput(): Promise<SubmissionInput> {
  const [owner] = await db!.insert(schema.coveV3AppTransactions).values({ network, operation: "BACKING_BUY", tokenId: "token",
    walletScript: "wallet", stateHash: "state", backingTxid: "parent", backingVout: 1, unsignedTxDigest: digest,
    psbtBase64: "unsigned", status: "BUILT", idempotencyKey: randomUUID() }).returning();
  return { network, sourceKind: "APP", sourceId: owner!.id, operation: "BACKING_BUY", tokenId: "token",
    backingTxid: "parent", backingVout: 1, unsignedTxDigest: digest, walletPsbtBase64: "wallet-signed-original" };
}
async function fillInput(): Promise<SubmissionInput> {
  await db!.insert(schema.coveV3MarketListings).values({ network, tokenId: "token", listingId: "listing", chainIdentity: "fixture-chain", orderVersion: 1,
    sellerTokenScript: "seller", sellerPayoutScript: "seller", sellerTokenChangeScript: "seller", sourceTxid: "source", sourceVout: 0, sourceAmountAtoms: 100n,
    amountAtoms: 100n, totalPriceSats: 1000n, expiryHeight: 200n, creationHeight: 100n,
    nonce: "nonce", signatureB64: "signature", sellerPresignedPsbt: "presigned", status: "RESERVED" });
  const [owner] = await db!.insert(schema.coveV3MarketFills).values({ network, tokenId: "token", listingId: "listing",
    buyerTokenScript: "buyer", buyerChangeScript: "buyer", buyerFundInputs: [], amountAtoms: 100n, totalPriceSats: 1000n,
    marketFeeSats: 5n, extraCarrierSats: 0n, minerFeeSats: 500n, unsignedTxDigest: digest, psbtBase64: "buyer-signed",
    status: "BUYER_SIGNED", reservationExpiresAt: new Date(0) }).returning();
  return { network, sourceKind: "FILL", sourceId: owner!.id, operation: "P2P", tokenId: "token", backingTxid: null,
    backingVout: null, unsignedTxDigest: digest, walletPsbtBase64: "buyer-signed" };
}

const expireLease = (id: string) => db!.execute(sql`update cove_v3_submissions set lease_until=clock_timestamp()-interval '1 second', next_attempt_at=clock_timestamp()-interval '1 second' where id=${id}`);

describe.skipIf(!isolated)("durable submissions on isolated PostgreSQL", () => {
  beforeAll(async () => { await migrate(db!, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) }); }, 30000);
  beforeEach(async () => { await db!.execute(sql`truncate cove_v3_submissions, cove_v3_app_transactions, cove_v3_market_fills, cove_v3_market_listings, cove_v3_market_events, cove_v3_token_metadata, cove_v3_signing_journal`); });
  afterAll(async () => { await pool?.end(); });

  it("persists the first wallet commitment before signing and survives a new client", async () => {
    const input = await appInput();
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => prepareSubmission(db!, input)));
    expect(new Set(outcomes.map((r) => r.id)).size).toBe(1);
    const later = await prepareSubmission(db!, { ...input, walletPsbtBase64: "different-witness" });
    expect(later.walletPsbtBase64).toBe("wallet-signed-original");
    const restartPool = new Pool({ connectionString: url });
    try {
      expect((await getSubmission(drizzle(restartPool, { schema }), network, "APP", input.sourceId))?.phase).toBe("SIGNING");
    } finally { await restartPool.end(); }
    await expect(prepareSubmission(db!, { ...input, unsignedTxDigest: "ef".repeat(32) })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("allows one concurrent attempt and fences a superseded signing result", async () => {
    const prepared = await prepareSubmission(db!, await appInput());
    const claims = await Promise.allSettled(Array.from({ length: 10 }, () => claimSubmission(db!, prepared.id)));
    const winners = claims.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const old = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof claimSubmission>>>).value;
    await expireLease(old.id);
    const replacement = await claimSubmission(db!, old.id);
    await expect(saveSignedSubmission(db!, old, { rawTxHex: "stale-bytes", txid })).rejects.toMatchObject({ code: "LEASE_LOST" });
    await deferSubmission(db!, old);
    const [current] = await db!.select().from(schema.coveV3Submissions).where(eq(schema.coveV3Submissions.id, old.id));
    expect(current?.leaseToken).toBe(replacement.leaseToken);
    expect(current?.rawTxHex).toBeNull();
  });

  it.each(["APP", "FILL"] as const)("retains exact bytes across acceptance-before-commit crash for %s", async (kind) => {
    const input = kind === "APP" ? await appInput() : await fillInput();
    const prepared = await prepareSubmission(db!, input);
    const ready = await saveSignedSubmission(db!, await claimSubmission(db!, prepared.id), { rawTxHex: "exact-signed-transaction", txid });
    expect((await getSubmission(db!, network, kind, input.sourceId))?.rawTxHex).toBe("exact-signed-transaction");
    expect((await dueSubmissions(db!, network)).length).toBe(0);
    await expireLease(ready.id);
    expect((await dueSubmissions(db!, network))[0]?.rawTxHex).toBe("exact-signed-transaction");
    const recovered = await claimSubmission(db!, ready.id);
    await expect(publishSubmission(db!, ready)).rejects.toMatchObject({ code: "LEASE_LOST" });
    await publishSubmission(db!, recovered);
    const accepted = await getSubmission(db!, network, kind, input.sourceId);
    expect(accepted?.phase).toBe("BROADCAST");
    expect(accepted?.rawTxHex).toBe(ready.rawTxHex);
    expect(await dueSubmissions(db!, network)).toEqual([]);
    if (kind === "FILL") {
      const events = await db!.select().from(schema.coveV3MarketEvents);
      expect(events).toHaveLength(1);
      await expect(publishSubmission(db!, recovered)).rejects.toMatchObject({ code: "LEASE_LOST" });
      expect(await db!.select().from(schema.coveV3MarketEvents)).toHaveLength(1);
    }
  });

  it("does not overwrite a newer confirmed session while publishing acceptance", async () => {
    const input = await appInput();
    const prepared = await prepareSubmission(db!, input);
    const ready = await saveSignedSubmission(db!, await claimSubmission(db!, prepared.id), { rawTxHex: "signed", txid });
    await db!.update(schema.coveV3AppTransactions).set({ status: "CONFIRMED", txid }).where(eq(schema.coveV3AppTransactions.id, input.sourceId));
    await publishSubmission(db!, ready);
    const [session] = await db!.select().from(schema.coveV3AppTransactions);
    expect(session?.status).toBe("CONFIRMED");
  });

  it("can acknowledge the same deterministic transaction for two independently created sessions", async () => {
    const inputs = await Promise.all([appInput(), appInput()]);
    const jobs = await Promise.all(inputs.map(async (input) => {
      const intent = await prepareSubmission(db!, input);
      return saveSignedSubmission(db!, await claimSubmission(db!, intent.id), { rawTxHex: "same-signed-bytes", txid });
    }));
    await Promise.all(jobs.map((job) => publishSubmission(db!, job)));
    for (const input of inputs) expect((await getSubmission(db!, network, "APP", input.sourceId))?.phase).toBe("BROADCAST");
  });

  it("holds a rejected signing request until an explicit retry without releasing its commitment", async () => {
    const input = await appInput();
    const claimed = await claimSubmission(db!, (await prepareSubmission(db!, input)).id);
    await haltSubmission(db!, claimed);
    await deferSubmission(db!, claimed);
    expect(await dueSubmissions(db!, network)).toEqual([]);
    expect((await getSubmission(db!, network, "APP", input.sourceId))?.phase).toBe("RECOVERY_REQUIRED");
    await expect(claimSubmission(db!, claimed.id)).rejects.toMatchObject({ code: "BUSY" });
    await resumeSubmission(db!, claimed.id);
    const retried = await claimSubmission(db!, claimed.id);
    expect(retried.walletPsbtBase64).toBe(input.walletPsbtBase64);
    expect(retried.leaseToken).not.toBe(claimed.leaseToken);
    await haltSubmission(db!, claimed);
    expect((await getSubmission(db!, network, "APP", input.sourceId))?.phase).toBe("SIGNING");
  });

  it("publishes launch metadata with acceptance atomically", async () => {
    const input = await appInput();
    await db!.update(schema.coveV3AppTransactions).set({ operation: "DEPLOY", metadataJson: { displayName: "Name", description: "Description" } });
    const prepared = await prepareSubmission(db!, { ...input, operation: "DEPLOY" });
    const ready = await saveSignedSubmission(db!, await claimSubmission(db!, prepared.id), { rawTxHex: "signed", txid });
    await publishSubmission(db!, ready);
    const [metadata] = await db!.select().from(schema.coveV3TokenMetadata);
    expect(metadata?.deployTxid).toBe(txid);
    expect(metadata?.displayName).toBe("Name");
  });
});
