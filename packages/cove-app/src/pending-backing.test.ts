import { describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@crclaunch/db";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import {
  buildDeployPsbtV3,
  buildMintPsbtV3,
  type GuardianTransitionSigner,
} from "@crclaunch/cove-guardian/v3";
import { V3AppService } from "./service.js";
import { loadV3AppConfig } from "./config.js";

function fixture() {
  const config = loadV3AppConfig({ COVE_NETWORK: "regtest" });
  const script = Buffer.from("0014" + "aa".repeat(20), "hex");
  const deploy = buildDeployPsbtV3({
    network: bitcoin.networks.regtest,
    identity: {
      chainIdentity: config.chainIdentity,
      policyVersion: 3,
      ticker: "BATCH",
      tokenNonce: Buffer.alloc(32, 1),
    },
    guardianXOnly: config.guardianXOnly,
    recoveryKeyXOnly: config.recoveryKeyXOnly,
    feeScript: config.feeScript,
    creatorScript: script,
    deployerInputs: [{ txid: "aa".repeat(32), vout: 0, script, valueSats: 1_000_000n }],
    deployerChangeScript: script,
    minerFeeSats: 1000n,
  });
  const backing = {
    state: deploy.s0,
    input: {
      txid: "bb".repeat(32),
      vout: 1,
      script: deploy.vault.scriptPubKey,
      valueSats: 10_000n,
    },
  };
  const mint = buildMintPsbtV3({
    network: bitcoin.networks.regtest,
    tokenId: deploy.tokenId,
    prevState: deploy.s0,
    prevBacking: backing.input,
    mintAmountAtoms: 1_000_000n * 100_000_000n,
    guardianXOnly: config.guardianXOnly,
    recoveryKeyXOnly: config.recoveryKeyXOnly,
    buyerInputs: [{ txid: "cc".repeat(32), vout: 0, script, valueSats: 1_000_000n }],
    buyerCarrierScript: script,
    buyerChangeScript: script,
    creatorScript: script,
    feeScript: config.feeScript,
    minerFeeSats: 1000n,
  });
  const tx = bitcoin.Transaction.fromBuffer(mint.psbt.data.globalMap.unsignedTx.toBuffer());
  const cursor = { height: "100", block_hash: "11".repeat(32), generation: "1", rebuilding: false };
  const execute = vi.fn(async (query: SQL) => {
    const text = new PgDialect().sqlToQuery(query).sql;
    return {
      rows: text.includes("with accepted")
        ? text && new PgDialect().sqlToQuery(query).params.includes(backing.input.txid)
          ? [{ txid: tx.getId(), operation: "BACKING_BUY" }]
          : []
        : [{ ...cursor }],
    };
  });
  const provider = {
    getBlockchainInfo: vi.fn().mockResolvedValue({ blocks: 100, bestBlockHash: cursor.block_hash }),
    getMempoolSpender: vi.fn().mockResolvedValue(undefined),
    getMempoolSnapshot: vi.fn().mockImplementation(async () => new Set([tx.getId()])),
    isTransactionInMempool: vi.fn(() => {
      throw new Error("per-candidate lookup forbidden");
    }),
    getRawTransaction: vi.fn().mockResolvedValue(tx.toHex()),
    getTxout: vi.fn().mockResolvedValue({
      valueSats: BigInt(tx.outs[1]!.value),
      scriptPubKeyHex: tx.outs[1]!.script.toString("hex"),
    }),
  };
  const app = new V3AppService(
    { execute } as unknown as Database,
    provider as unknown as CoreRpcProvider,
    config,
    {} as GuardianTransitionSigner,
  );
  const follow = app as unknown as {
    followPendingBacking(
      token: string,
      backing: unknown,
      stopAt?: { txid: string; vout: number },
    ): Promise<{ input: { txid: string } }>;
  };
  return {
    provider,
    execute,
    cursor,
    tx,
    backing,
    tokenId: deploy.tokenId.toString("hex"),
    follow,
  };
}

describe("fresh live pending branch fencing", () => {
  it("reuses discovery membership across ancestry and checks final membership in one RPC", async () => {
    const f = fixture();
    expect((await f.follow.followPendingBacking(f.tokenId, f.backing)).input.txid).toBe(
      f.tx.getId(),
    );
    expect(f.provider.getMempoolSnapshot).toHaveBeenCalledTimes(2);
    expect(f.provider.isTransactionInMempool).not.toHaveBeenCalled();
    expect(f.provider.getTxout).toHaveBeenCalledTimes(1);
    expect(f.provider.getRawTransaction).toHaveBeenCalledTimes(1);
  });
  it.each([
    "eviction",
    "tip-reorg",
    "cursor-reorg",
    "generation",
    "membership-failure",
    "spent-head",
    "invalid-transition",
    "malformed-raw",
  ])("fails closed on %s during traversal", async (change) => {
    const f = fixture();
    if (change === "eviction")
      f.provider.getMempoolSnapshot
        .mockResolvedValueOnce(new Set([f.tx.getId()]))
        .mockResolvedValueOnce(new Set());
    if (change === "membership-failure")
      f.provider.getMempoolSnapshot
        .mockResolvedValueOnce(new Set([f.tx.getId()]))
        .mockRejectedValueOnce(new Error("429"));
    if (change === "tip-reorg")
      f.provider.getBlockchainInfo
        .mockResolvedValueOnce({ blocks: 100, bestBlockHash: f.cursor.block_hash })
        .mockResolvedValueOnce({ blocks: 100, bestBlockHash: "22".repeat(32) });
    if (change === "cursor-reorg" || change === "generation")
      f.provider.getRawTransaction.mockImplementation(async () => {
        if (change === "cursor-reorg") f.cursor.block_hash = "22".repeat(32);
        else f.cursor.generation = "2";
        return f.tx.toHex();
      });
    if (change === "spent-head") f.provider.getTxout.mockResolvedValue(null);
    if (change === "invalid-transition")
      f.provider.getRawTransaction.mockResolvedValue(new bitcoin.Transaction().toHex());
    if (change === "malformed-raw") f.provider.getRawTransaction.mockResolvedValue("invalid");
    await expect(f.follow.followPendingBacking(f.tokenId, f.backing)).rejects.toThrow(
      change === "membership-failure" ? "CORE_UNAVAILABLE" : "STATE_CHANGED",
    );
  });
  it("checks the head after final membership so a newly accepted successor fails closed", async () => {
    const f = fixture();
    let snapshots = 0;
    f.provider.getMempoolSnapshot.mockImplementation(async () => {
      if (++snapshots === 2) f.provider.getTxout.mockResolvedValue(null);
      return new Set([f.tx.getId()]);
    });
    await expect(f.follow.followPendingBacking(f.tokenId, f.backing)).rejects.toThrow(
      "STATE_CHANGED",
    );
  });
  it("rechecks accepted ancestry even when submitting against an earlier pending outpoint", async () => {
    const f = fixture();
    f.provider.getMempoolSnapshot
      .mockResolvedValueOnce(new Set([f.tx.getId()]))
      .mockResolvedValueOnce(new Set());
    await expect(
      f.follow.followPendingBacking(f.tokenId, f.backing, { txid: f.tx.getId(), vout: 1 }),
    ).rejects.toThrow("STATE_CHANGED");
    expect(f.provider.getTxout).not.toHaveBeenCalled();
  });
});
