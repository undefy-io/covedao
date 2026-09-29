import { expect, it, vi } from "vitest";
import { MarketService } from "./service.js";
import { defaultMarketConfig } from "./config.js";
import { RpcError, type CoreRpcProvider } from "@crclaunch/bitcoin";
import type { Database } from "@crclaunch/db";

it.each([
  { state: "unknown", blockHash: null },
  { state: "mined", blockHash: "cd".repeat(32) },
  new RpcError("getmempoolentry", "http", "HTTP 429", 429),
  new Error("timeout"),
])("does not invalidate our fill or unlock its listing from an inconclusive observation", async (observation) => {
  const listing = { listingId: "listing", status: "BROADCAST", sourceTxid: "ab".repeat(32), sourceVout: 0, expiryHeight: 200n };
  const batches = [[], [], [], [listing], []];
  const db = {
    select: () => {
      const result = batches.shift() ?? [];
      const chain = { from: () => chain, where: () => chain, orderBy: () => chain,
        limit: async () => result, then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve) };
      return chain;
    },
    transaction: vi.fn(), update: vi.fn(() => ({ set: () => ({ where: async () => [] }) })),
  } as unknown as Database;
  const observe = observation instanceof Error ? vi.fn().mockRejectedValue(observation) : vi.fn().mockResolvedValue(observation);
  const provider = { getTxout: vi.fn().mockResolvedValue(null), observeTransaction: observe } as unknown as CoreRpcProvider;
  const service = new MarketService(db, provider, defaultMarketConfig("regtest", Buffer.alloc(22)));
  const invalidate = vi.fn();
  Object.assign(service, {
    sourceUtxoRow: vi.fn().mockResolvedValue({ canonical: true, spentByTxid: null }),
    latestFillTxid: vi.fn().mockResolvedValue("ef".repeat(32)),
    invalidateListing: invalidate,
  });
  expect(await service.reconcileMarket(100n)).toEqual({ expired: 0, invalidated: 0, confirmed: 0, reorged: 0 });
  expect(invalidate).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledTimes(1);
});
