import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startCrcPolling } from "./crc-poll";

let doc: EventTarget & { visibilityState: string }, win: EventTarget;
beforeEach(() => {
  vi.useFakeTimers();
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  win = new EventTarget();
  vi.stubGlobal("document", doc); vi.stubGlobal("window", win);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test("loads immediately, polls every five seconds, and stops on cleanup", async () => {
  const read = vi.fn().mockResolvedValue(undefined);
  const stop = startCrcPolling(read);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(read).toHaveBeenCalledTimes(2);
  stop();
  win.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(2);
});

test("pauses hidden-tab requests and refreshes immediately on return", async () => {
  const read = vi.fn().mockResolvedValue(undefined);
  const stop = startCrcPolling(read);
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(1);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(read).toHaveBeenCalledTimes(2);
  stop();
});

test("focus never overlaps an in-flight read and cleanup aborts it", async () => {
  let release!: () => void;
  const read = vi.fn((_signal: AbortSignal) => new Promise<void>((resolve) => { release = resolve; }));
  const stop = startCrcPolling(read);
  win.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(1);
  stop();
  expect(read.mock.calls[0]![0].aborted).toBe(true);
  release();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(1);
});

test("a failed read does not stop later refreshes", async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error("temporary outage")).mockResolvedValue(undefined);
  const stop = startCrcPolling(read);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(read).toHaveBeenCalledTimes(2);
  stop();
});
