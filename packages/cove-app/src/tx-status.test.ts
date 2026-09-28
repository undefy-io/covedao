import { describe, expect, it, vi } from "vitest";
import { V3AppService } from "./service.js";
import { loadV3AppConfig } from "./config.js";
import { RpcError, type CoreRpcProvider } from "@crclaunch/bitcoin";
import type { Database } from "@crclaunch/db";
import type { GuardianTransitionSigner } from "@crclaunch/cove-guardian/v3";

const txid = "ab".repeat(32);
function fixture(results: unknown[][], observeTransaction = vi.fn()) {
  const where = vi.fn(() => {
    const result = Promise.resolve(results.shift() ?? []);
    return Object.assign(result, { limit: () => result });
  });
  const select = vi.fn((_fields?: Record<string, unknown>) => ({ from: () => ({ where }) }));
  const db = { select, update: vi.fn() } as unknown as Database;
  const provider = { observeTransaction, getRawTransaction: vi.fn() } as unknown as CoreRpcProvider;
  const app = new V3AppService(db, provider, loadV3AppConfig({ COVE_NETWORK: "regtest" }), {} as GuardianTransitionSigner);
  return { app, provider, db, select };
}

describe("public transaction status", () => {
  it("uses canonical indexed confirmation without calling RPC or returning signing data", async () => {
    const { app, provider } = fixture([[{ status: "CONFIRMED", psbtBase64: "secret", idempotencyKey: "secret", errorCode: "secret" }],
      [{ blockHeight: 123n, blockHash: "cd".repeat(32), createdAt: new Date() }]]);
    const status = await app.txStatus(txid);
    expect(status.state).toBe("confirmed");
    expect(status.confirmedHeight).toBe(123n);
    expect(status.confirmedBlockHash).toBe("cd".repeat(32));
    expect(status.session).toEqual({ status: "CONFIRMED" });
    expect(JSON.stringify(status, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("secret");
    expect(provider.observeTransaction).not.toHaveBeenCalled();
  });

  it.each(["mempool", "mined"] as const)("reports a positive %s observation without claiming indexed confirmation", async (state) => {
    const observe = vi.fn().mockResolvedValue({ state, blockHash: state === "mined" ? "cd".repeat(32) : null });
    const { app } = fixture([[{ status: "BROADCAST" }], []], observe);
    const status = await app.txStatus(txid);
    expect(status.state).toBe(state === "mempool" ? "pending" : "mined");
    expect(status.confirmedHeight).toBeNull();
    expect(status.mempool).toBe(state === "mempool");
    expect(status.stale).toBe(false);
  });

  it.each([new Error("timeout"), new RpcError("getmempoolentry", "http", "HTTP 429", 429)])("preserves unknown on RPC failures", async (error) => {
    const { app } = fixture([[{ status: "BROADCAST" }], []], vi.fn().mockRejectedValue(error));
    expect(await app.txStatus(txid)).toMatchObject({ state: "unknown", mempool: null, stale: true, session: { status: "BROADCAST" } });
  });

  it("does not let arbitrary public txids trigger RPC lookups", async () => {
    const { app, provider } = fixture([[], [], []]);
    expect(await app.txStatus(txid)).toMatchObject({ state: "unknown", mempool: null });
    expect(provider.observeTransaction).not.toHaveBeenCalled();
  });

  it("admits a tracked market fill without exposing its private data", async () => {
    const observe = vi.fn().mockResolvedValue({ state: "mempool", blockHash: null });
    const { app } = fixture([[], [], [{ id: "fill" }]], observe);
    expect(await app.txStatus(txid)).toMatchObject({ state: "pending", session: null });
    expect(observe).toHaveBeenCalledTimes(1);
  });
});

it("reconciliation never fails a broadcast session when indexing has not confirmed it", async () => {
  const { app, provider, db } = fixture([[{ id: "session", txid }], []]);
  expect(await app.reconcileAppSessions()).toEqual({ confirmed: 0 });
  expect(db.update).not.toHaveBeenCalled();
  expect(provider.getRawTransaction).not.toHaveBeenCalled();
  expect(provider.observeTransaction).not.toHaveBeenCalled();
});

it("public fill status selects only allowlisted columns", async () => {
  const { app, select } = fixture([[{ id: "fill", status: "BROADCAST", txid }]]);
  expect(await app.publicFillStatus("fill")).toMatchObject({ id: "fill", txid });
  expect(Object.keys(select.mock.calls[0]![0] as object).sort()).toEqual([
    "blockHash", "blockHeight", "canonical", "id", "status", "tokenId", "txid", "updatedAt",
  ]);
});

it.each([
  [new RpcError("getrawtransaction", "rpc", "not found", 500, -5), "STATE_CHANGED"],
  [new RpcError("getrawtransaction", "http", "HTTP 429", 429), "CORE_UNAVAILABLE"],
  [new Error("timeout"), "CORE_UNAVAILABLE"],
])("a pending backing read failure cannot expose the parent as tradable", async (error, code) => {
  const { app, provider } = fixture([[{ txid, operation: "BACKING_BUY" }]]);
  vi.mocked(provider.getRawTransaction).mockRejectedValue(error);
  const follow = app as unknown as { followPendingBacking(tokenId: string, backing: unknown): Promise<unknown> };
  await expect(follow.followPendingBacking("cd".repeat(32), { input: { txid: "ef".repeat(32), vout: 0 } })).rejects.toThrow(String(code));
});
