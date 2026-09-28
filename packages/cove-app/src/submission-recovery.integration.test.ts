import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { CoveChainView, stateHashV2 } from "@crclaunch/cove-covenant";
import { CHAIN_BITCOIN_REGTEST } from "@crclaunch/cove-wire";
import { buildDeployPsbtV3, buildMintPsbtV3 } from "@crclaunch/cove-guardian/v3";
import { unsignedTxDigest } from "./psbt.js";
import { createDb, schema, prepareSubmission, claimSubmission, saveSignedSubmission, getSubmission } from "@crclaunch/db";
import { sql } from "drizzle-orm";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { GuardianTransitionSigner } from "@crclaunch/cove-guardian/v3";
import { V3AppService } from "./service.js";
import { loadV3AppConfig } from "./config.js";
import { createTxSession } from "./tx-session.js";

const url = process.env.SUBMISSION_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/submissions_test";

describe.skipIf(!isolated)("app submission recovery on isolated PostgreSQL", () => {
  beforeEach(async () => {
    await createDb(url!).execute(sql`truncate cove_v3_submissions, cove_v3_app_transactions, cove_v3_market_fills, cove_v3_market_listings, cove_v3_market_events, cove_v3_market_cancellations`);
  });

  it("recovers node acceptance followed by database failure without another Guardian signature", async () => {
    const db = createDb(url!);
    const tx = new bitcoin.Transaction();
    tx.addInput(Buffer.from(randomUUID().replaceAll("-", "").repeat(2), "hex"), 0);
    tx.addOutput(Buffer.from("51", "hex"), 1000);
    const txid = tx.getId(), rawTxHex = tx.toHex();
    const [session] = await db.insert(schema.coveV3AppTransactions).values({ network: "regtest", operation: "BACKING_BUY", tokenId: "recovery-token",
      walletScript: "wallet", backingTxid: "parent", backingVout: 1, unsignedTxDigest: "ab".repeat(32), psbtBase64: "original", status: "BUILT", idempotencyKey: randomUUID() }).returning();
    const prepared = await prepareSubmission(db, { network: "regtest", sourceKind: "APP", sourceId: session!.id, operation: "BACKING_BUY",
      tokenId: "recovery-token", backingTxid: "parent", backingVout: 1, unsignedTxDigest: "ab".repeat(32), walletPsbtBase64: "durable-wallet-signature" });
    const ready = await saveSignedSubmission(db, await claimSubmission(db, prepared.id), { txid, rawTxHex });
    await db.execute(sql`update cove_v3_submissions set lease_until=null where id=${ready.id}`);
    const provider = {
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: "regtest" }), testMempoolAccept: vi.fn().mockResolvedValue({ allowed: true }),
      broadcastTransaction: vi.fn().mockResolvedValue(txid), observeTransaction: vi.fn().mockResolvedValue({ state: "mempool", blockHash: null }),
    };
    const signer = { signMint: vi.fn(), signRedeem: vi.fn() };
    const createService = () => {
      const app = new V3AppService(db, provider as unknown as CoreRpcProvider, loadV3AppConfig({ COVE_NETWORK: "regtest" }), signer as unknown as GuardianTransitionSigner);
      Object.assign(app, { requireHealthy: vi.fn().mockResolvedValue(undefined) });
      return app;
    };
    vi.spyOn(db, "transaction").mockImplementationOnce(async () => { throw new Error("crash after provider acceptance"); });
    expect(await createService().recoverSubmissions()).toEqual({ recovered: 0 });
    expect((await getSubmission(db, "regtest", "APP", session!.id))?.rawTxHex).toBe(rawTxHex);
    expect((await getSubmission(db, "regtest", "APP", session!.id))?.phase).toBe("READY");
    await db.execute(sql`update cove_v3_submissions set next_attempt_at=clock_timestamp()-interval '1 second' where id=${ready.id}`);
    provider.testMempoolAccept.mockResolvedValue({ allowed: false });
    expect(await createService().recoverSubmissions()).toEqual({ recovered: 1 });
    expect((await getSubmission(db, "regtest", "APP", session!.id))?.phase).toBe("BROADCAST");
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(provider.broadcastTransaction).toHaveBeenCalledWith(rawTxHex);
    expect(signer.signMint).not.toHaveBeenCalled();
    expect(signer.signRedeem).not.toHaveBeenCalled();
  });

  it.each(["REMOTE_GUARDIAN_UNAVAILABLE", "BACKING_ALREADY_SIGNED"])("distinguishes %s from ambiguous signing recovery", async (reason) => {
    const db = createDb(url!);
    const config = { ...loadV3AppConfig({ COVE_NETWORK: "regtest" }), discoveryEnvelope: false };
    const key = Buffer.alloc(32, 0x46), publicKey = Buffer.from(ecc.pointFromScalar(key, true)!);
    const wallet = { publicKey, sign: (hash: Buffer) => Buffer.from(ecc.sign(hash, key)) };
    const script = bitcoin.payments.p2wpkh({ pubkey: publicKey }).output!;
    const identity = { chainIdentity: CHAIN_BITCOIN_REGTEST, policyVersion: 3, ticker: "TEST", tokenNonce: Buffer.alloc(32, 1) };
    const deploy = buildDeployPsbtV3({ network: bitcoin.networks.regtest, identity, guardianXOnly: config.guardianXOnly,
      recoveryKeyXOnly: config.recoveryKeyXOnly, recoveryProfile: config.recoveryProfile, feeScript: config.feeScript,
      deployerInputs: [{ txid: "aa".repeat(32), vout: 0, script, valueSats: 1_000_000n }], deployerChangeScript: script, creatorScript: script, minerFeeSats: 1000n });
    const backing = { txid: "bb".repeat(32), vout: 1, script: deploy.vault.scriptPubKey, valueSats: 10_000n };
    const mint = buildMintPsbtV3({ network: bitcoin.networks.regtest, tokenId: deploy.tokenId, prevState: deploy.s0, prevBacking: backing,
      mintAmountAtoms: 1_000_000n * 100_000_000n, guardianXOnly: config.guardianXOnly, recoveryKeyXOnly: config.recoveryKeyXOnly,
      recoveryProfile: config.recoveryProfile, buyerInputs: [{ txid: "cc".repeat(32), vout: 0, script, valueSats: 1_000_000n }],
      buyerCarrierScript: script, buyerChangeScript: script, feeScript: config.feeScript, creatorScript: script, minerFeeSats: 1000n });
    const session = await createTxSession(db, { network: "regtest", operation: "BACKING_BUY", tokenId: deploy.tokenId.toString("hex"), walletScript: script.toString("hex"),
      walletAddress: null, stateHash: stateHashV2(deploy.s0), backingTxid: backing.txid, backingVout: 1, unsignedTxDigest: unsignedTxDigest(mint.psbt),
      psbtBase64: mint.psbt.toBase64(), status: "BUILT", expiresAtHeight: null, idempotencyKey: randomUUID() });
    mint.psbt.signInput(1, wallet);
    const view = new CoveChainView(); view.deploy({ tokenId: deploy.tokenId, ticker: "TEST", policyVersion: 3, deployTxid: backing.txid,
      tokenNonce: identity.tokenNonce, creatorScript: script }, backing, deploy.s0);
    const signer = { signMint: vi.fn().mockResolvedValue({ ok: false, reason, detail: "fixture", audit: null }) };
    const app = new V3AppService(db, {} as CoreRpcProvider, config, signer as unknown as GuardianTransitionSigner);
    Object.assign(app, { loadView: async () => view, loadBackingAt: async () => ({ input: backing, state: deploy.s0, stateHash: stateHashV2(deploy.s0) }) });
    await expect(app.submitBackingBuy({ sessionId: session.id, signedPsbtBase64: mint.psbt.toBase64() })).rejects.toMatchObject({
      code: reason === "REMOTE_GUARDIAN_UNAVAILABLE" ? "CORE_UNAVAILABLE" : "GUARDIAN_REJECTED",
    });
    expect((await getSubmission(db, "regtest", "APP", session.id))?.phase).toBe(reason === "REMOTE_GUARDIAN_UNAVAILABLE" ? "SIGNING" : "RECOVERY_REQUIRED");
  });

  it("creates one session under concurrent idempotency-key retries", async () => {
    const db = createDb(url!);
    const input = { network: "regtest", operation: "TRANSFER" as const, tokenId: "token", walletScript: "wallet", walletAddress: null,
      stateHash: null, backingTxid: null, backingVout: null, unsignedTxDigest: "ef".repeat(32), psbtBase64: "unsigned", status: "BUILT" as const,
      expiresAtHeight: null, idempotencyKey: randomUUID() };
    const sessions = await Promise.all(Array.from({ length: 20 }, () => createTxSession(db, input)));
    expect(new Set(sessions.map((s) => s.id)).size).toBe(1);
    await expect(createTxSession(db, { ...input, unsignedTxDigest: "ff".repeat(32) })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });
});
