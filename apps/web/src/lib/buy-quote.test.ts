import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBuyQuote } from "./buy-quote";

const unavailable = { ok: false, error: { code: "CORE_UNAVAILABLE", retryable: true } };
const success = { ok: true, data: { stateHash: "current" } };
function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("buy quote recovery", () => {
  it("recovers after a temporary 503 without a state revision change", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(503, unavailable)).mockResolvedValueOnce(response(200, success));
    vi.stubGlobal("fetch", fetch);
    const pending = fetchBuyQuote("token", "100000000000", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(success);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe("/api/v3/backing/buy/quote");
      expect(JSON.parse(options.body)).toEqual({ tokenId: "token", amountAtoms: "100000000000" });
    }
  });

  it.each([400, 500])("does not retry HTTP %s even if the response says retryable", async (status) => {
    const fetch = vi.fn().mockResolvedValue(response(status, unavailable));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchBuyQuote("token", "100000000000", new AbortController().signal)).toEqual(unavailable);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a nonretryable 503", async () => {
    const result = { ok: false, error: { retryable: false } };
    const fetch = vi.fn().mockResolvedValue(response(503, result));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchBuyQuote("token", "100000000000", new AbortController().signal)).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops after bounded attempts when observations remain unavailable", async () => {
    const fetch = vi.fn().mockImplementation(async () => response(503, unavailable));
    vi.stubGlobal("fetch", fetch);
    const pending = fetchBuyQuote("token", "100000000000", new AbortController().signal);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(unavailable);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels scheduled retries when the old input is abandoned", async () => {
    const fetch = vi.fn().mockResolvedValue(response(503, unavailable));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = fetchBuyQuote("token", "100000000000", controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates cancellation to an in-flight request", async () => {
    const fetch = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = fetchBuyQuote("token", "100000000000", controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never starts work for an already cancelled request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(fetchBuyQuote("token", "100000000000", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
