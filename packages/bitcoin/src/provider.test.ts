import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreRpcProvider, btcPerKvbToSatPerVb, testMempoolAcceptParams } from "./provider.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CoreRpcProvider authentication", () => {
  it("sends an API key in x-api-key without Basic authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: 123, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CoreRpcProvider({ url: "https://bitcoin-signet.gateway.tatum.io", apiKey: "test-api-key" });

    expect(await provider.getBestHeight()).toBe(123);
    const [, request] = fetchMock.mock.calls[0]!;
    expect(request.headers["x-api-key"]).toBe("test-api-key");
    expect(request.headers.authorization).toBeUndefined();
  });

  it("rejects combining an API key with Basic credentials", () => {
    expect(() => new CoreRpcProvider({ url: "https://example.com", apiKey: "key", user: "user" })).toThrow(/cannot be combined/);
  });

  it("retries an HTTP 429 before returning the RPC result", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: 123, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CoreRpcProvider({ url: "https://example.com", apiKey: "test-api-key" });

    const height = provider.getBestHeight();
    await vi.runAllTimersAsync();
    expect(await height).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("btcPerKvbToSatPerVb (estimatesmartfee conversion)", () => {
  it("converts 0.00001000 BTC/kvB → 1 sat/vB", () => {
    expect(btcPerKvbToSatPerVb(0.00001)).toBe(1n);
  });

  it("converts 0.00002000 BTC/kvB → 2 sat/vB", () => {
    expect(btcPerKvbToSatPerVb(0.00002)).toBe(2n);
  });

  it("rounds sub-satoshi rates up to at least 1 sat/vB", () => {
    expect(btcPerKvbToSatPerVb(0.00000345)).toBe(1n);
  });

  it("falls back to 2 sat/vB for missing/zero/negative feerate", () => {
    expect(btcPerKvbToSatPerVb(0)).toBe(2n);
    expect(btcPerKvbToSatPerVb(-1)).toBe(2n);
    expect(btcPerKvbToSatPerVb(Number.NaN)).toBe(2n);
    expect(btcPerKvbToSatPerVb(Number.POSITIVE_INFINITY)).toBe(2n);
  });
});

describe("testMempoolAcceptParams (RPC arg shape)", () => {
  it("without maxfeerate → [[hex]]", () => {
    expect(testMempoolAcceptParams("00ff")).toEqual([["00ff"]]);
  });

  it("with maxfeerate → [[hex], maxfeerate] (NOT [[hex, maxfeerate]])", () => {
    expect(testMempoolAcceptParams("00ff", 0.0005)).toEqual([["00ff"], 0.0005]);
  });
});
