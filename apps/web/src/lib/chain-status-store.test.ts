import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ChainStatusStore,
  indexedRefreshKey,
  pendingRefreshKey,
  type ChainStatus,
} from "./chain-status-store";
const healthy = (): ChainStatus => ({
  network: "signet",
  appEnabled: true,
  core: { reachable: true, height: "101", tip: "tip" },
  indexer: {
    health: "HEALTHY",
    indexedHeight: "101",
    indexedBlockHash: "tip",
    stateRoot: "root",
    lag: "0",
    rebuilding: false,
  },
  guardian: { configured: true },
  market: { enabled: true },
  observations: {
    chainGeneration: "1",
    pendingRevision: "1",
    marketRevision: "1",
    metadataRevision: "0",
    pendingObservedAt: new Date().toISOString(),
    feesObservedAt: new Date().toISOString(),
  },
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

it("shares one poll and changes pending reads without refetching unchanged confirmed reads", async () => {
  const read = vi.fn(async () => healthy()),
    store = new ChainStatusStore(read, () => true);
  const off1 = store.subscribe(vi.fn()),
    off2 = store.subscribe(vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  const indexed = indexedRefreshKey(store.getSnapshot()),
    pending = pendingRefreshKey(store.getSnapshot());
  read.mockImplementation(async () => ({
    ...healthy(),
    observations: { ...healthy().observations!, pendingRevision: "2", marketRevision: "2" },
  }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(indexedRefreshKey(store.getSnapshot())).toBe(indexed);
  expect(pendingRefreshKey(store.getSnapshot())).not.toBe(pending);
  read.mockImplementation(async () => ({
    ...healthy(),
    indexer: { ...healthy().indexer, indexedBlockHash: "replacement" },
    observations: { ...healthy().observations!, chainGeneration: "2" },
  }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(indexedRefreshKey(store.getSnapshot())).not.toBe(indexed);
  off1();
  off2();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(read).toHaveBeenCalledTimes(3);
});
it("marks observations unavailable on expiry and recovers even when hashes/revisions are unchanged", async () => {
  let fail = false;
  const store = new ChainStatusStore(
    async () => {
      if (fail) throw new Error("offline");
      return healthy();
    },
    () => true,
  );
  const off = store.subscribe(vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getSnapshot().available).toBe(true);
  fail = true;
  await vi.advanceTimersByTimeAsync(15001);
  expect(store.getSnapshot()).toMatchObject({ available: false, pendingAvailable: false });
  const key = pendingRefreshKey(store.getSnapshot());
  fail = false;
  await vi.advanceTimersByTimeAsync(5000);
  expect(store.getSnapshot().available).toBe(true);
  expect(pendingRefreshKey(store.getSnapshot())).not.toBe(key);
  off();
});
it("ages pending freshness independently of a successful status fetch", async () => {
  const initial = healthy();
  const store = new ChainStatusStore(
    async () => initial,
    () => true,
  );
  const off = store.subscribe(vi.fn());
  await vi.advanceTimersByTimeAsync(15001);
  expect(store.getSnapshot()).toMatchObject({ available: true, pendingAvailable: false });
  off();
});
it("pauses hidden tabs and ignores delayed responses from an older focus generation", async () => {
  let visible = true,
    resolveOld!: (s: ChainStatus) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<ChainStatus>((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockImplementation(async () => healthy());
  const store = new ChainStatusStore(read, () => visible),
    off = store.subscribe(vi.fn());
  visible = false;
  store.pause();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(read).toHaveBeenCalledTimes(1);
  visible = true;
  store.resume();
  await vi.advanceTimersByTimeAsync(0);
  resolveOld({ ...healthy(), network: "regtest" });
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getSnapshot().status?.network).toBe("signet");
  const revision = pendingRefreshKey(store.getSnapshot());
  store.broadcast();
  expect(pendingRefreshKey(store.getSnapshot())).not.toBe(revision);
  off();
});
it("expires fees even when status remains healthy and fee revisions stop changing", async () => {
  const initial = healthy();
  const store = new ChainStatusStore(
    async () => ({
      ...initial,
      observations: { ...initial.observations!, pendingObservedAt: new Date().toISOString() },
    }),
    () => true,
  );
  const off = store.subscribe(vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getSnapshot().feesAvailable).toBe(true);
  await vi.advanceTimersByTimeAsync(120001);
  expect(store.getSnapshot()).toMatchObject({ available: true, feesAvailable: false });
  off();
});
