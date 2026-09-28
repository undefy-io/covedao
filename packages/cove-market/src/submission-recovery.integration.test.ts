import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import { createDb, schema, prepareSubmission, claimSubmission, saveSignedSubmission, getSubmission } from "@crclaunch/db";
import { eq, sql } from "drizzle-orm";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { MarketService } from "./service.js";
import { defaultMarketConfig } from "./config.js";
import type * as OrderSignature from "./order/signature.js";

vi.mock("./health.js", () => ({ assertMarketReady: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./order/signature.js", async (original) => ({ ...await original<typeof OrderSignature>(), verifyCancellationAuthorization: () => true }));
const url = process.env.SUBMISSION_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/submissions_test";

async function fixture() {
  const db = createDb(url!), listingId = randomBytes(32).toString("hex");
  await db.insert(schema.coveV3MarketListings).values({ network: "regtest", tokenId: "market-recovery", listingId, chainIdentity: "fixture", orderVersion: 1,
    sellerTokenScript: "51", sellerPayoutScript: "51", sellerTokenChangeScript: "51", sourceTxid: randomBytes(32).toString("hex"), sourceVout: 0,
    sourceAmountAtoms: 100n, amountAtoms: 100n, totalPriceSats: 1000n, expiryHeight: 200n, creationHeight: 100n,
    nonce: randomUUID(), signatureB64: "signature", sellerPresignedPsbt: "private-seller-witness", status: "RESERVED" });
  const [fill] = await db.insert(schema.coveV3MarketFills).values({ network: "regtest", tokenId: "market-recovery", listingId,
    buyerTokenScript: "51", buyerChangeScript: "51", buyerFundInputs: [], amountAtoms: 100n, totalPriceSats: 1000n, marketFeeSats: 5n,
    extraCarrierSats: 0n, minerFeeSats: 500n, unsignedTxDigest: "ab".repeat(32), psbtBase64: "private-buyer-witness", status: "BUYER_SIGNED",
    reservationExpiresAt: new Date(0) }).returning();
  const intent = await prepareSubmission(db, { network: "regtest", sourceKind: "FILL", sourceId: fill!.id, operation: "P2P", tokenId: fill!.tokenId,
    backingTxid: null, backingVout: null, unsignedTxDigest: fill!.unsignedTxDigest!, walletPsbtBase64: fill!.psbtBase64! });
  const tx = new bitcoin.Transaction();
  tx.addInput(randomBytes(32), 0); tx.addOutput(Buffer.from("51", "hex"), 1000);
  const ready = await saveSignedSubmission(db, await claimSubmission(db, intent.id), { rawTxHex: tx.toHex(), txid: tx.getId() });
  await db.execute(sql`update cove_v3_submissions set lease_until=null where id=${ready.id}`);
  const provider = { getBlockchainInfo: vi.fn().mockResolvedValue({ chain: "regtest" }), testMempoolAccept: vi.fn().mockResolvedValue({ allowed: true }),
    broadcastTransaction: vi.fn().mockResolvedValue(tx.getId()), observeTransaction: vi.fn().mockResolvedValue({ state: "mempool" }),
    getTxout: vi.fn().mockResolvedValue({ valueSats: 546n }) };
  return { db, fill: fill!, listingId, ready, provider, market: new MarketService(db, provider as unknown as CoreRpcProvider, defaultMarketConfig("regtest", Buffer.from("51", "hex"))) };
}

describe.skipIf(!isolated)("market recovery on isolated PostgreSQL", () => {
  beforeEach(async () => {
    await createDb(url!).execute(sql`truncate cove_v3_submissions, cove_v3_app_transactions, cove_v3_market_fills, cove_v3_market_listings, cove_v3_market_events, cove_v3_market_cancellations`);
  });

  it("recovers acceptance before database commit once without rebuilding signatures", async () => {
    const { db, fill, ready, provider, market } = await fixture();
    vi.spyOn(db, "transaction").mockImplementationOnce(async () => { throw new Error("commit crash"); });
    expect(await market.recoverSubmission(ready)).toEqual({ txid: ready.txid, submissionState: "saved" });
    expect((await getSubmission(db, "regtest", "FILL", fill.id))?.phase).toBe("READY");
    await db.execute(sql`update cove_v3_submissions set next_attempt_at=clock_timestamp()-interval '1 second' where id=${ready.id}`);
    provider.testMempoolAccept.mockResolvedValue({ allowed: false });
    const restarted = new MarketService(db, provider as unknown as CoreRpcProvider, market.config);
    expect(await restarted.completeFill(fill.id)).toEqual({ txid: ready.txid, submissionState: "broadcast" });
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(provider.broadcastTransaction).toHaveBeenCalledWith(ready.rawTxHex);
    const events = await db.select().from(schema.coveV3MarketEvents).where(eq(schema.coveV3MarketEvents.fillId, fill.id));
    expect(events).toHaveLength(1);
    expect(await restarted.completeFill(fill.id)).toEqual({ txid: ready.txid, submissionState: "broadcast" });
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it("retains submitting fills and seller signatures across expiry and cancellation", async () => {
    const { db, fill, listingId, market } = await fixture();
    await expect(market.cancelListing(listingId, "ab".repeat(32), "authorized")).rejects.toMatchObject({ code: "STATE_CHANGED" });
    await market.reconcileMarket(100n);
    const [current] = await db.select().from(schema.coveV3MarketFills).where(eq(schema.coveV3MarketFills.id, fill.id));
    const [listing] = await db.select().from(schema.coveV3MarketListings).where(eq(schema.coveV3MarketListings.listingId, listingId));
    expect(current?.status).toBe("SUBMITTING");
    expect(listing?.sellerPresignedPsbt).toBe("private-seller-witness");
  });

  it("honors a lowered operational settlement cap before rebroadcasting saved bytes", async () => {
    const { market, ready, provider } = await fixture();
    market.config.maxP2pSettlementSats = 500n;
    await expect(market.recoverSubmission(ready)).rejects.toThrow();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });
});
