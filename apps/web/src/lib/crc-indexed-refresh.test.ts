import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrcIndexedRefreshStore } from "./crc-indexed-refresh";

let doc: EventTarget & { visibilityState: string }, win: EventTarget;
beforeEach(() => {
  vi.useFakeTimers();
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  win = new EventTarget();
  vi.stubGlobal("document", doc); vi.stubGlobal("window", win);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test("shares status polling and refreshes only a changed indexed hash", async () => {
  let hash = "a";
  const status = vi.fn(async () => ({ network: "signet", indexedTip: { height: "10", blockHash: hash } }));
  const store = new CrcIndexedRefreshStore(status);
  const first = vi.fn(), second = vi.fn();
  const stopFirst = store.subscribe(first), stopSecond = store.subscribe(second);
  await vi.advanceTimersByTimeAsync(0);
  expect(status).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  hash = "replacement-at-same-height";
  await vi.advanceTimersByTimeAsync(5_000);
  expect(first).toHaveBeenCalledTimes(2);
  expect(second).toHaveBeenCalledTimes(2);
  stopFirst(); stopSecond();
  const reads = status.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(status).toHaveBeenCalledTimes(reads);
});

test("failed projections retry on unchanged status while successful reads remain untouched", async () => {
  const status = vi.fn(async () => ({ network: "signet", indexedTip: { height: "10", blockHash: "a" } }));
  const store = new CrcIndexedRefreshStore(status);
  const read = vi.fn().mockRejectedValueOnce(new Error("outage")).mockResolvedValue(undefined);
  const stop = store.subscribe(read);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(2);
  stop();
});

test("queues the latest indexed hash during a read and aborts on unsubscribe", async () => {
  let hash = "a", release!: () => void;
  const store = new CrcIndexedRefreshStore(async () => ({ network: "signet", indexedTip: { height: "10", blockHash: hash } }));
  const read = vi.fn((_signal: AbortSignal) => new Promise<void>((resolve) => { release = resolve; }));
  const stop = store.subscribe(read);
  await vi.advanceTimersByTimeAsync(0);
  hash = "b";
  await vi.advanceTimersByTimeAsync(5_000);
  expect(read).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  stop();
  expect(read.mock.calls[1]![0].aborted).toBe(true);
  release();
});

test("a queued revision waits until the hidden tab becomes visible again", async () => {
  let hash = "a", release!: () => void;
  const store = new CrcIndexedRefreshStore(async () => ({ network: "signet", indexedTip: { height: "10", blockHash: hash } }));
  const read = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const stop = store.subscribe(read);
  await vi.advanceTimersByTimeAsync(0);
  hash = "b";
  await vi.advanceTimersByTimeAsync(5_000);
  doc.visibilityState = "hidden";
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  stop(); release();
});
