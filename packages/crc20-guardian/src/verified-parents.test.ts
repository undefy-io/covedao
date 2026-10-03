import { expect, test, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { VerifiedParentCache } from "./verified-parents";
function parent(n: number) { const tx = new bitcoin.Transaction(); tx.addInput(Buffer.alloc(32, n), 0); tx.addOutput(Buffer.from("0014" + "12".repeat(20), "hex"), 1000); return tx; }
test("coalesces and caches only hash-verified immutable content within entry/byte bounds", async () => {
  const a = parent(1), b = parent(2);
  const fetch = vi.fn(async (id: string) => id === a.getId() ? a.toHex() : b.toHex());
  const cache = new VerifiedParentCache(fetch, 1, 10000);
  await Promise.all(Array.from({ length: 10 }, () => cache.get(a.getId())));
  await cache.get(a.getId()); expect(fetch).toHaveBeenCalledOnce();
  await cache.get(b.getId()); await cache.get(a.getId()); expect(fetch).toHaveBeenCalledTimes(3);
  const uncached = new VerifiedParentCache(fetch, 1, 2);
  await uncached.get(a.getId()); await uncached.get(a.getId()); expect(fetch).toHaveBeenCalledTimes(5);
});
test("wrong hash and failed observations cannot poison later valid deployment checks", async () => {
  const a = parent(1), b = parent(2), fetch = vi.fn().mockResolvedValueOnce(b.toHex()).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(a.toHex());
  const cache = new VerifiedParentCache(fetch);
  await expect(cache.get(a.getId())).rejects.toThrow("parent mismatch");
  await expect(cache.get(a.getId())).rejects.toThrow("offline");
  await expect(cache.get(a.getId())).resolves.toBe(a.toHex());
  await cache.get(a.getId()); expect(fetch).toHaveBeenCalledTimes(3);
});
