import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreRpcProvider, btcPerKvbToSatPerVb, testMempoolAcceptParams } from "./provider.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CoreRpcProvider authentication", () => {
  it("shares simultaneous transaction reads without caching mempool presence", async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(Response.json({ result: null, error: { message: "transaction not found" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CoreRpcProvider({ url: "https://example.com" });
    const a = provider.getRawTransaction("ab".repeat(32));
    const b = provider.getRawTransaction("ab".repeat(32));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(Response.json({ result: "raw", error: null }));
    expect(await Promise.all([a, b])).toEqual(["raw", "raw"]);
    await expect(provider.getRawTransaction("ab".repeat(32))).rejects.toThrow("transaction not found");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

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

  it("does not retry a rate-limited status probe", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CoreRpcProvider({ url: "https://example.com" });
    await expect(provider.getBlockchainInfo({ retry: false })).rejects.toThrow("HTTP 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a rate-limit backoff when the caller's budget expires", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CoreRpcProvider({ url: "https://example.com" });
    const controller = new AbortController();
    const pending = provider.getBlockchainInfo({ signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("fee deadline");
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new Error("fee deadline"));
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a slow status RPC with the caller's deadline", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, request: RequestInit) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
    })));
    const provider = new CoreRpcProvider({ url: "https://example.com" });
    const controller = new AbortController();
    const pending = provider.getBlockchainInfo({ signal: controller.signal, retry: false });
    const rejected = expect(pending).rejects.toThrow("status deadline");
    controller.abort(new Error("status deadline"));
    await rejected;
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
