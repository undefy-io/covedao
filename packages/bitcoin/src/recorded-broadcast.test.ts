import { describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { broadcastRecordedTransaction } from "./recorded-broadcast.js";
import { RpcError, type CoreRpcProvider } from "./provider.js";

const transaction = new bitcoin.Transaction();
transaction.addInput(Buffer.alloc(32, 1), 0);
transaction.addOutput(Buffer.from("51", "hex"), 1000);
const signed = { rawTxHex: transaction.toHex(), txid: transaction.getId() };
function fixture() {
  const provider = {
    getBlockchainInfo: vi.fn().mockResolvedValue({ chain: "signet" }),
    testMempoolAccept: vi.fn().mockResolvedValue({ allowed: true }),
    broadcastTransaction: vi.fn().mockResolvedValue(signed.txid),
    observeTransaction: vi.fn().mockResolvedValue({ state: "unknown", blockHash: null }),
  };
  return { provider, rpc: provider as unknown as CoreRpcProvider };
}

describe("recorded transaction broadcast", () => {
  it("reuses the submission network observation while still preflighting and broadcasting", async () => {
    const { provider, rpc } = fixture();
    const observation = { chain: "signet", blocks: 100, bestBlockHash: "aa".repeat(32) };
    expect(await broadcastRecordedTransaction(rpc, signed, "signet", observation)).toBe(
      signed.txid,
    );
    expect(provider.getBlockchainInfo).not.toHaveBeenCalled();
    expect(provider.testMempoolAccept).toHaveBeenCalledTimes(1);
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    await expect(broadcastRecordedTransaction(rpc, signed, "mainnet", observation)).rejects.toThrow(
      "network mismatch",
    );
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });
  it("sends exactly the saved bytes and preserves deterministic identity", async () => {
    const { provider, rpc } = fixture();
    expect(await broadcastRecordedTransaction(rpc, signed, "signet")).toBe(signed.txid);
    expect(provider.testMempoolAccept).toHaveBeenCalledWith(signed.rawTxHex);
    expect(provider.broadcastTransaction).toHaveBeenCalledWith(signed.rawTxHex);
  });
  it("refuses wrong-network recovery before sending", async () => {
    const { provider, rpc } = fixture();
    await expect(broadcastRecordedTransaction(rpc, signed, "mainnet")).rejects.toThrow(
      "network mismatch",
    );
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(provider.testMempoolAccept).not.toHaveBeenCalled();
  });
  it("rejects corrupt stored identity before any RPC", async () => {
    const { provider, rpc } = fixture();
    await expect(
      broadcastRecordedTransaction(rpc, { ...signed, txid: "00".repeat(32) }, "signet"),
    ).rejects.toThrow("identity mismatch");
    expect(provider.getBlockchainInfo).not.toHaveBeenCalled();
  });
  it.each(["mempool", "mined"])(
    "converges after acceptance-before-commit crash with positive %s evidence",
    async (state) => {
      const { provider, rpc } = fixture();
      provider.testMempoolAccept.mockResolvedValue({ allowed: false });
      provider.observeTransaction.mockResolvedValue({ state, blockHash: null });
      expect(await broadcastRecordedTransaction(rpc, signed, "signet")).toBe(signed.txid);
      expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    },
  );
  it("does not treat a quota failure as acceptance or eviction", async () => {
    const { provider, rpc } = fixture();
    provider.testMempoolAccept.mockResolvedValue({ allowed: false });
    provider.observeTransaction.mockRejectedValue(
      new RpcError("getmempoolentry", "http", "HTTP 429", 429),
    );
    await expect(broadcastRecordedTransaction(rpc, signed, "signet")).rejects.toThrow("HTTP 429");
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });
  it("retains an ambiguous failed send until positive evidence is available", async () => {
    const { provider, rpc } = fixture();
    provider.broadcastTransaction.mockRejectedValue(new Error("request timeout"));
    await expect(broadcastRecordedTransaction(rpc, signed, "signet")).rejects.toThrow(
      "request timeout",
    );
    provider.observeTransaction.mockResolvedValue({ state: "mempool", blockHash: null });
    expect(await broadcastRecordedTransaction(rpc, signed, "signet")).toBe(signed.txid);
    expect(provider.broadcastTransaction.mock.calls.map((args) => args[0])).toEqual([
      signed.rawTxHex,
      signed.rawTxHex,
    ]);
  });
  it("accepts Core's already-in-chain code without requiring txindex", async () => {
    const { provider, rpc } = fixture();
    provider.broadcastTransaction.mockRejectedValue(
      new RpcError("sendrawtransaction", "rpc", "already in block chain", 500, -27),
    );
    expect(await broadcastRecordedTransaction(rpc, signed, "signet")).toBe(signed.txid);
    expect(provider.observeTransaction).not.toHaveBeenCalled();
  });
  it("does not accept an unrelated broadcast txid without independent evidence", async () => {
    const { provider, rpc } = fixture();
    provider.broadcastTransaction.mockResolvedValue("00".repeat(32));
    await expect(broadcastRecordedTransaction(rpc, signed, "signet")).rejects.toThrow(
      "identity mismatch",
    );
  });
});
