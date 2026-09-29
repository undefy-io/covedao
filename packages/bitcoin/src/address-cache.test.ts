import { afterEach, expect, it, vi } from "vitest";
import { AddressLookupBusy, AddressUtxoCache } from "./address-cache.js";

const address = "tb1qg358gsla30dtx228u3za8253zncpzdwkrl6eem";
const coin = { txid: "ab".repeat(32), vout: 0, value: 10_000, status: { confirmed: true, block_height: 123 } };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("deduplicates concurrent wallet reads and shares only its own source tip", async () => {
  const fetchMock = vi.fn(async (url: string) => url.endsWith("/height") ? new Response("125") : Response.json([coin]));
  vi.stubGlobal("fetch", fetchMock);
  const cache = new AddressUtxoCache();
  const reads = await Promise.all(Array.from({ length: 30 }, () => cache.read("https://a.example", "signet", address, "tip1", async () => "tip1")));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(reads.every((rows) => rows[0]?.confirmations === 3)).toBe(true);
  reads[0]![0]!.confirmations = 99;
  expect((await cache.read("https://a.example", "signet", address, "tip1", async () => "tip1"))[0]?.confirmations).toBe(3);
  await cache.read("https://b.example", "signet", address, "tip1", async () => "tip1");
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("bounds unique in-flight requests without queueing callers or caching errors", async () => {
  let release!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
  const cache = new AddressUtxoCache(2, 1);
  const first = cache.read("https://a.example", "signet", address, "one", async () => "one");
  await expect(cache.read("https://b.example", "signet", address, "one", async () => "one")).rejects.toBeInstanceOf(AddressLookupBusy);
  release(Response.json([]));
  expect(await first).toEqual([]);
});

it("does not publish or reinsert results fetched across broadcast or tip invalidation", async () => {
  let release!: (value: Response) => void;
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }))
    .mockResolvedValue(Response.json([]));
  vi.stubGlobal("fetch", fetchMock);
  const cache = new AddressUtxoCache();
  let generation = "before";
  const stale = cache.read("https://a.example", "signet", address, generation, async () => generation);
  generation = "after";
  await cache.read("https://a.example", "signet", address, generation, async () => generation);
  release(Response.json([]));
  await expect(stale).rejects.toBeInstanceOf(AddressLookupBusy);
  await cache.read("https://a.example", "signet", address, generation, async () => generation);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("expires pending balances between blocks and evicts when capacity is full", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => Response.json([]));
  vi.stubGlobal("fetch", fetchMock);
  const cache = new AddressUtxoCache(1);
  const read = (source: string) => cache.read(source, "signet", address, "tip", async () => "tip");
  await read("https://a.example");
  await read("https://a.example");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5_001);
  await read("https://a.example");
  await read("https://b.example");
  await read("https://a.example");
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it.each([{}, [{ ...coin, value: 1.5 }], [{ ...coin, txid: "bad" }], [{ ...coin, status: { confirmed: true } }]])("rejects malformed source values: %j", async (body) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
  await expect(new AddressUtxoCache().read("https://a.example", "signet", address, "tip", async () => "tip")).rejects.toThrow("invalid UTXOs");
});

it("fences a slow result when a source returns to an earlier tip after invalidation", async () => {
  let release!: (value: Response) => void;
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }))
    .mockImplementation(async () => Response.json([]));
  vi.stubGlobal("fetch", fetchMock);
  const cache = new AddressUtxoCache();
  const stale = cache.read("https://a.example", "signet", address, "A", async () => "A");
  await cache.read("https://a.example", "signet", address, "B", async () => "B");
  await cache.read("https://a.example", "signet", address, "A", async () => "A");
  release(Response.json([]));
  await expect(stale).rejects.toBeInstanceOf(AddressLookupBusy);
  await cache.read("https://a.example", "signet", address, "A", async () => "A");
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
