import { describe, expect, it, vi } from "vitest";
import { V3AppService } from "./service.js";
import { loadV3AppConfig } from "./config.js";
import { RpcError, type CoreRpcProvider } from "@crclaunch/bitcoin";
import type { Database } from "@crclaunch/db";
import type { GuardianTransitionSigner } from "@crclaunch/cove-guardian/v3";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const txid = "ab".repeat(32);
function fixture(results: unknown[][], observeTransaction = vi.fn()) {
  const where = vi.fn(() => {
    const result = Promise.resolve(results.shift() ?? []);
    return Object.assign(result, { limit: () => result });
  });
  const select = vi.fn((_fields?: Record<string, unknown>) => ({ from: () => ({ where }) }));
  const db = {
    execute: vi.fn((query: SQL) =>
      Promise.resolve({
        rows: new PgDialect().sqlToQuery(query).sql.includes("with accepted")
          ? (results.shift() ?? [])
          : [{ height: "100", block_hash: "11".repeat(32), generation: "1", rebuilding: false }],
      }),
    ),
    select,
    selectDistinct: select,
    update: vi.fn(),
  } as unknown as Database;
  const provider = {
    observeTransaction,
    getMempoolSpender: vi.fn().mockResolvedValue(undefined),
    getMempoolSnapshot: vi.fn().mockImplementation(async () => new Set([txid])),
    getBlockchainInfo: vi.fn().mockResolvedValue({ blocks: 100, bestBlockHash: "11".repeat(32) }),
    isTransactionInMempool: vi.fn().mockResolvedValue(true),
    getTxout: vi.fn(),
    getRawTransaction: vi.fn(),
  } as unknown as CoreRpcProvider;
  const app = new V3AppService(
    db,
    provider,
    loadV3AppConfig({ COVE_NETWORK: "regtest" }),
    {} as GuardianTransitionSigner,
  );
  return { app, provider, db, select };
}

describe("public transaction status", () => {
  function statusFixture(row: Record<string, unknown>) {
    const f = fixture([]);
    Object.assign(f.db, { execute: vi.fn().mockResolvedValue({ rows: [row] }) });
    return f;
  }
  it("uses one DB snapshot without RPC or signing data", async () => {
    const { app, provider, db } = statusFixture({
      session_status: "CONFIRMED",
      confirmed_height: "123",
      confirmed_hash: "cd".repeat(32),
      confirmed_at: new Date(),
      psbt_base64: "secret",
      idempotency_key: "secret",
      error_code: "secret",
    });
    const status = await app.txStatus(txid);
    expect(status).toMatchObject({
      state: "confirmed",
      confirmedHeight: 123n,
      session: { status: "CONFIRMED" },
    });
    expect(
      JSON.stringify(status, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain("secret");
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(provider.observeTransaction).not.toHaveBeenCalled();
  });
  it.each(["pending", "unknown"])("uses the durable %s observation", async (state) => {
    const { app, provider } = statusFixture({
      session_status: "BROADCAST",
      observed_state: state,
      fresh: true,
      observed_at: new Date(),
    });
    expect(await app.txStatus(txid)).toMatchObject({
      state,
      mempool: state === "pending" ? true : null,
      stale: false,
      confirmedHeight: null,
    });
    expect(provider.observeTransaction).not.toHaveBeenCalled();
  });
  it.each([{}, { session_status: "BROADCAST", observed_state: "pending", fresh: false }])(
    "does not query the chain for missing or stale observations",
    async (row) => {
      const { app, provider } = statusFixture(row);
      expect(await app.txStatus(txid)).toMatchObject({
        state: "unknown",
        mempool: null,
        stale: true,
      });
      expect(provider.observeTransaction).not.toHaveBeenCalled();
    },
  );
  it("revisits canonical conflicts after reorg without RPC", async () => {
    const { app, db, provider } = statusFixture({});
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [{ session_status: "BROADCAST", conflict: true }] } as never)
      .mockResolvedValueOnce({
        rows: [
          { session_status: "BROADCAST", conflict: false, observed_state: "pending", fresh: true },
        ],
      } as never);
    expect(await app.txStatus(txid)).toMatchObject({
      state: "conflicted",
      mempool: false,
      stale: false,
    });
    expect(await app.txStatus(txid)).toMatchObject({ state: "pending", mempool: true });
    expect(provider.observeTransaction).not.toHaveBeenCalled();
  });
  it("a formerly confirmed session becomes reorged when its canonical event disappears", async () => {
    const { app } = statusFixture({ session_status: "CONFIRMED" });
    expect(await app.txStatus(txid)).toMatchObject({
      state: "unknown",
      session: { status: "REORGED" },
      confirmedHeight: null,
    });
  });
});

it("reconciliation never fails a broadcast session when indexing has not confirmed it", async () => {
  const { app, provider, db } = fixture([[{ id: "session", txid }], []]);
  Object.assign(db, {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: async () => ({ rows: [] }) }),
  });
  expect(await app.reconcileAppSessions()).toEqual({ confirmed: 0 });
  expect(db.update).not.toHaveBeenCalled();
  expect(provider.getRawTransaction).not.toHaveBeenCalled();
  expect(provider.observeTransaction).not.toHaveBeenCalled();
});

it("public fill status selects only allowlisted columns", async () => {
  const { app, select } = fixture([[{ id: "fill", status: "BROADCAST", txid }]]);
  expect(await app.publicFillStatus("fill")).toMatchObject({ id: "fill", txid });
  expect(Object.keys(select.mock.calls[0]![0] as object).sort()).toEqual([
    "blockHash",
    "blockHeight",
    "canonical",
    "id",
    "status",
    "tokenId",
    "txid",
    "updatedAt",
  ]);
});

it.each([
  [new RpcError("getrawtransaction", "rpc", "not found", 500, -5), "STATE_CHANGED"],
  [new RpcError("getrawtransaction", "http", "HTTP 429", 429), "CORE_UNAVAILABLE"],
  [new Error("timeout"), "CORE_UNAVAILABLE"],
])("a pending backing read failure cannot expose the parent as tradable", async (error, code) => {
  const { app, provider } = fixture([[{ txid, operation: "BACKING_BUY" }]]);
  vi.mocked(provider.getRawTransaction).mockRejectedValue(error);
  const follow = app as unknown as {
    followPendingBacking(tokenId: string, backing: unknown): Promise<unknown>;
  };
  await expect(
    follow.followPendingBacking("cd".repeat(32), { input: { txid: "ef".repeat(32), vout: 0 } }),
  ).rejects.toThrow(String(code));
});

it("a positively absent pending candidate leaves its verified unspent parent tradable", async () => {
  const { app, provider } = fixture([[{ txid, operation: "BACKING_BUY" }]]);
  vi.mocked(provider.getMempoolSnapshot).mockResolvedValue(new Set());
  const script = Buffer.from("5120" + "aa".repeat(32), "hex");
  vi.mocked(provider.getTxout).mockResolvedValue({
    scriptPubKeyHex: script.toString("hex"),
    valueSats: 10_000n,
    confirmations: 1,
  });
  const backing = { input: { txid: "ef".repeat(32), vout: 1, script, valueSats: 10_000n } };
  const follow = app as unknown as {
    followPendingBacking(id: string, backing: unknown): Promise<unknown>;
  };
  expect(await follow.followPendingBacking("cd".repeat(32), backing)).toMatchObject(backing);
  expect(provider.getRawTransaction).not.toHaveBeenCalled();
});

it("a failed membership lookup cannot expose the parent as tradable", async () => {
  const { app, provider } = fixture([[{ txid, operation: "BACKING_BUY" }]]);
  vi.mocked(provider.getMempoolSnapshot).mockRejectedValue(
    new RpcError("getrawmempool", "http", "HTTP 429", 429),
  );
  const follow = app as unknown as {
    followPendingBacking(id: string, backing: unknown): Promise<unknown>;
  };
  await expect(
    follow.followPendingBacking("cd".repeat(32), { input: { txid, vout: 1 } }),
  ).rejects.toThrow("CORE_UNAVAILABLE");
  expect(provider.getTxout).not.toHaveBeenCalled();
});

it("an absent or changed pending ancestor requires a new quote when submitting its descendant", async () => {
  const { app, provider } = fixture([[]]);
  const follow = app as unknown as {
    followPendingBacking(
      id: string,
      backing: unknown,
      stopAt: { txid: string; vout: number },
    ): Promise<unknown>;
  };
  await expect(
    follow.followPendingBacking(
      "cd".repeat(32),
      { input: { txid, vout: 1 } },
      { txid: "ef".repeat(32), vout: 1 },
    ),
  ).rejects.toThrow("STATE_CHANGED");
  expect(provider.getRawTransaction).not.toHaveBeenCalled();
});
