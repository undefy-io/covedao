import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegtestScanScheduler, type ScanRpcCaller } from "./regtest-scan";

function provider(call: ReturnType<typeof vi.fn>): ScanRpcCaller {
  return { call } as ScanRpcCaller;
}

describe("regtest scan scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("bounds admission and shares one Core scanner", async () => {
    const scheduler = new RegtestScanScheduler(2);
    let finish!: (value: { unspents: string[] }) => void;
    const call = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ unspents: ["second"] });
    const first = scheduler.scan(provider(call), ["first"]);
    const second = scheduler.scan(provider(call), ["second"]);
    await expect(scheduler.scan(provider(call), ["third"])).rejects.toMatchObject({ name: "CapacityUnavailable" });
    expect(call).toHaveBeenCalledTimes(1);
    finish({ unspents: ["first"] });
    await expect(first).resolves.toEqual(["first"]);
    await expect(second).resolves.toEqual(["second"]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls.every(([method, params]) => method === "scantxoutset" && params[0] === "start")).toBe(true);
  });

  it("expires queued work without ever starting a later Core scan", async () => {
    const scheduler = new RegtestScanScheduler(2, 100);
    let finish!: (value: { unspents: never[] }) => void;
    const call = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const first = scheduler.scan(provider(call), ["first"]).catch((error) => error);
    const queued = scheduler.scan(provider(call), ["queued"]).catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toMatchObject({ name: "CapacityUnavailable" });
    expect(await queued).toMatchObject({ name: "CapacityUnavailable" });
    finish({ unspents: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledTimes(1);
    call.mockResolvedValue({ unspents: [] });
    await expect(scheduler.scan(provider(call), ["new"])).resolves.toEqual([]);
  });

  it("removes canceled queued work promptly and admits a replacement", async () => {
    const scheduler = new RegtestScanScheduler(2);
    let finish!: (value: { unspents: never[] }) => void;
    const call = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ unspents: [] });
    const first = scheduler.scan(provider(call), ["first"]);
    const controller = new AbortController();
    const queued = scheduler.scan(provider(call), ["canceled"], controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "CapacityUnavailable" });
    const replacement = scheduler.scan(provider(call), ["replacement"]);
    finish({ unspents: [] });
    await first;
    await expect(replacement).resolves.toEqual([]);
    expect(call.mock.calls.map(([, params]) => params[1][0].desc)).toEqual(["addr(first)", "addr(replacement)"]);
  });

  it("retries Core scan contention, then releases the slot", async () => {
    const scheduler = new RegtestScanScheduler(1, 1000, 10);
    const call = vi.fn().mockRejectedValueOnce(new Error("Scan already in progress"))
      .mockResolvedValue({ unspents: ["found"] });
    const result = scheduler.scan(provider(call), ["retry"]);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toEqual(["found"]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(scheduler.scan(provider(call), ["next"])).resolves.toEqual(["found"]);
  });

  it("cancels busy retry sleeps and never retries after the deadline", async () => {
    const scheduler = new RegtestScanScheduler(1, 50, 100);
    const call = vi.fn().mockRejectedValue(new Error("Scan already in progress"));
    const result = scheduler.scan(provider(call), ["busy"]).catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ name: "CapacityUnavailable" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(call).toHaveBeenCalledTimes(1);
    call.mockResolvedValue({ unspents: [] });
    await expect(scheduler.scan(provider(call), ["new"])).resolves.toEqual([]);
  });

  it("propagates cancellation to an active RPC and retains the slot until it settles", async () => {
    const scheduler = new RegtestScanScheduler(1);
    let finish!: (value: { unspents: never[] }) => void;
    const call = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const result = scheduler.scan(provider(call), ["active"], controller.signal);
    const signal = vi.mocked(provider(call).call).mock.calls[0]![2]!.signal!;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "CapacityUnavailable" });
    expect(signal.aborted).toBe(true);
    await expect(scheduler.scan(provider(call), ["overlap"])).rejects.toMatchObject({ name: "CapacityUnavailable" });
    finish({ unspents: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("never scans for an already aborted request", async () => {
    const scheduler = new RegtestScanScheduler();
    const controller = new AbortController();
    controller.abort();
    const call = vi.fn();
    await expect(scheduler.scan(provider(call), ["canceled"], controller.signal)).rejects.toMatchObject({ name: "CapacityUnavailable" });
    expect(call).not.toHaveBeenCalled();
  });

  it("limits busy retries and reports retryable capacity without a global abort", async () => {
    const scheduler = new RegtestScanScheduler(1, 30_000, 10);
    const call = vi.fn().mockRejectedValue(new Error("Scan already in progress"));
    const result = scheduler.scan(provider(call), ["busy"]).catch((error) => error);
    await vi.advanceTimersByTimeAsync(400);
    expect(await result).toMatchObject({ name: "CapacityUnavailable" });
    expect(call).toHaveBeenCalledTimes(41);
    expect(call.mock.calls.every(([method, params]) => method === "scantxoutset" && params[0] === "start")).toBe(true);
    call.mockResolvedValue({ unspents: [] });
    await expect(scheduler.scan(provider(call), ["new"])).resolves.toEqual([]);
  });
});
