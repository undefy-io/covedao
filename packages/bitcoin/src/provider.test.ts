import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreRpcProvider,
  RpcError,
  isRpcNotFound,
  btcPerKvbToSatPerVb,
  testMempoolAcceptParams,
} from "./provider.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RPC evidence", () => {
  const txid = "ab".repeat(32);
  const absent = () =>
    Response.json({ result: null, error: { code: -5, message: "not found" } }, { status: 500 });

  it("recognizes Core not-found on HTTP 500 without classifying transport or gateway errors as absence", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(absent())
        .mockResolvedValueOnce(
          Response.json({ error: { code: -5, message: "gateway failure" } }, { status: 502 }),
        )
        .mockRejectedValueOnce(new Error("offline")),
    );
    const provider = new CoreRpcProvider({ url: "https://example.com" });
    const errors: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        await provider.getRawTransaction(txid);
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toHaveLength(3);
    expect(isRpcNotFound(errors[0], "getrawtransaction")).toBe(true);
    expect(isRpcNotFound(errors[0], "getmempoolentry")).toBe(false);
    expect(isRpcNotFound(errors[1], "getrawtransaction")).toBe(false);
    expect(isRpcNotFound(errors[2], "getrawtransaction")).toBe(false);
  });

  it("redacts configured credentials from RPC errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("request failed with private-key")));
    const provider = new CoreRpcProvider({ url: "https://example.com", apiKey: "private-key" });
    await expect(provider.getRawTransaction(txid)).rejects.toThrow("[redacted]");
    await expect(provider.getRawTransaction(txid)).rejects.not.toThrow("private-key");
  });

  it("requires an explicit successful mempool membership response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ result: { vsize: 120 }, error: null }));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await new CoreRpcProvider({ url: "https://example.com" }).observeTransaction(txid),
    ).toEqual({ state: "mempool", blockHash: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).method).toBe("getmempoolentry");
  });

  it.each([
    [
      { txid, confirmations: 0 },
      { state: "unknown", blockHash: null },
    ],
    [
      { txid, confirmations: 1, blockhash: "cd".repeat(32) },
      { state: "mined", blockHash: "cd".repeat(32) },
    ],
  ])(
    "raw transaction availability alone never proves mempool membership",
    async (raw, expected) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(absent())
          .mockResolvedValueOnce(Response.json({ result: raw, error: null })),
      );
      expect(
        await new CoreRpcProvider({ url: "https://example.com" }).observeTransaction(txid),
      ).toEqual(expected);
    },
  );

  it("keeps missing raw transactions unknown because txindex may be unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(absent));
    expect(
      await new CoreRpcProvider({ url: "https://example.com" }).observeTransaction(txid),
    ).toEqual({ state: "unknown", blockHash: null });
  });

  it.each([402, 429, 502, 503])(
    "fails an unavailable membership probe without falling through to raw lookup: HTTP %s",
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        new CoreRpcProvider({ url: "https://example.com" }).observeTransaction(txid, {
          retry: false,
        }),
      ).rejects.toBeInstanceOf(RpcError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects malformed success responses instead of claiming membership", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ result: null, error: null })));
    await expect(
      new CoreRpcProvider({ url: "https://example.com" }).observeTransaction(txid),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it("accepts only an explicit null gettxout result as an absent output", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ result: {}, error: null }))
        .mockResolvedValueOnce(Response.json({ result: null, error: null })),
    );
    const provider = new CoreRpcProvider({ url: "https://example.com" });
    await expect(provider.getTxout(txid, 0)).rejects.toBeInstanceOf(RpcError);
    expect(await provider.getTxout(txid, 0)).toBeNull();
  });

  it("preserves the gettxout tip identity for coherent funding validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          result: {
            bestblock: "cd".repeat(32),
            scriptPubKey: { hex: "0014" + "00".repeat(20) },
            value: 0.001,
            confirmations: 3,
          },
          error: null,
        }),
      ),
    );
    expect(
      await new CoreRpcProvider({ url: "https://example.com" }).getTxout(txid, 0),
    ).toMatchObject({
      bestBlockHash: "cd".repeat(32),
      valueSats: 100_000n,
      confirmations: 3,
    });
  });
});

describe("CoreRpcProvider authentication", () => {
  it("shares simultaneous transaction reads without caching mempool presence", async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(
        Response.json({ result: null, error: { message: "transaction not found" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CoreRpcProvider({ url: "https://example.com" });
    const a = provider.getRawTransaction("ab".repeat(32));
    const b = provider.getRawTransaction("ab".repeat(32));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(Response.json({ result: "raw", error: null }));
    expect(await Promise.all([a, b])).toEqual(["raw", "raw"]);
    await expect(provider.getRawTransaction("ab".repeat(32))).rejects.toThrow(
      "transaction not found",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends an API key in x-api-key without Basic authorization", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: 123, error: null }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CoreRpcProvider({
      url: "https://bitcoin-signet.gateway.tatum.io",
      apiKey: "test-api-key",
    });

    expect(await provider.getBestHeight()).toBe(123);
    const [, request] = fetchMock.mock.calls[0]!;
    expect(request.headers["x-api-key"]).toBe("test-api-key");
    expect(request.headers.authorization).toBeUndefined();
  });

  it("rejects combining an API key with Basic credentials", () => {
    expect(
      () => new CoreRpcProvider({ url: "https://example.com", apiKey: "key", user: "user" }),
    ).toThrow(/cannot be combined/);
  });

  it("retries an HTTP 429 before returning the RPC result", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: 123, error: null }), { status: 200 }),
      );
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
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "60" } }));
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
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, request: RequestInit) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
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

describe("competing transaction observations", () => {
  const txid = "ab".repeat(32),
    spender = "cd".repeat(32);
  it("reads the confirmed UTXO set explicitly when validating competing inputs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ result: null, error: null }));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await new CoreRpcProvider({ url: "https://example.com" }).getTxout(txid, 1, false),
    ).toBeNull();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).params).toEqual([txid, 1, false]);
  });
  it.each([undefined, spender])(
    "identifies the current mempool spender in one lookup: %s",
    async (spendingtxid) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({
            result: [{ txid, vout: 1, ...(spendingtxid ? { spendingtxid } : {}) }],
            error: null,
          }),
        ),
      );
      expect(
        await new CoreRpcProvider({ url: "https://example.com" }).getMempoolSpender(txid, 1),
      ).toBe(spendingtxid ?? null);
    },
  );
  it("allows compatibility fallback only for an explicitly unsupported method", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { result: null, error: { code: -32601, message: "unsupported" } },
            { status: 500 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 429 })),
    );
    const provider = new CoreRpcProvider({ url: "https://example.com" });
    expect(await provider.getMempoolSpender(txid, 1, { retry: false })).toBeUndefined();
    expect(await provider.getMempoolSpender(txid, 1, { retry: false })).toBeUndefined();
    await expect(
      new CoreRpcProvider({ url: "https://example.com" }).getMempoolSpender(txid, 1, {
        retry: false,
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });
  it("does not cache transport errors or share capability by API key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ result: [{ txid, vout: 1, spendingtxid: spender }] }))
      .mockResolvedValueOnce(Response.json({ error: { code: -32601, message: "unsupported" } }))
      .mockResolvedValueOnce(Response.json({ result: [{ txid, vout: 1, spendingtxid: spender }] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CoreRpcProvider({ url: "https://first.example", apiKey: "shared-key" });
    await expect(provider.getMempoolSpender(txid, 1, { retry: false })).rejects.toBeInstanceOf(
      RpcError,
    );
    expect(await provider.getMempoolSpender(txid, 1)).toBe(spender);
    expect(await provider.getMempoolSpender(txid, 1)).toBeUndefined();
    expect(await provider.getMempoolSpender(txid, 1)).toBeUndefined();
    expect(
      await new CoreRpcProvider({
        url: "https://second.example",
        apiKey: "shared-key",
      }).getMempoolSpender(txid, 1),
    ).toBe(spender);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it.each([
    { result: [] },
    { result: [{}] },
    { result: [{ txid, vout: 2 }] },
    { result: [{ txid, vout: 1, spendingtxid: "invalid" }] },
  ])("rejects malformed mempool spender evidence", async ({ result }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ result, error: null })));
    await expect(
      new CoreRpcProvider({ url: "https://example.com" }).getMempoolSpender(txid, 1),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe("RPC attempt budgeting", () => {
  it("reacquires shared capacity for every gateway retry and releases before backoff", async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    const acquire = vi.fn(async () => release);
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => new Response(null, { status: 429 }))
      .mockImplementationOnce(async () => new Response(null, { status: 429 }))
      .mockImplementationOnce(async () => Response.json({ result: 100, error: null }));
    vi.stubGlobal("fetch", fetchMock);
    const result = new CoreRpcProvider({
      url: "https://example.com",
      budget: { acquire },
    }).getBestHeight();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe(100);
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("holds the shared concurrency lease until the response body is consumed", async () => {
    const release = vi.fn(async () => {});
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    const result = new CoreRpcProvider({
      url: "https://example.com",
      budget: { acquire: async () => release },
    }).getBestHeight();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(release).not.toHaveBeenCalled();
    controller.enqueue(new TextEncoder().encode('{"result":123,"error":null}'));
    controller.close();
    expect(await result).toBe(123);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("never starts RPC when shared capacity is exhausted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const error = new Error("busy");
    error.name = "CapacityUnavailable";
    const provider = new CoreRpcProvider({
      url: "https://example.com",
      budget: {
        acquire: async () => {
          throw error;
        },
      },
    });
    await expect(provider.getBestHeight()).rejects.toBe(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bounded batch mempool observations", () => {
  const a = "aa".repeat(32),
    b = "bb".repeat(32);
  it("fetches one membership snapshot and one ordered spender batch", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => Response.json({ result: [a, b] }))
      .mockImplementationOnce(async () =>
        Response.json({
          result: [
            { txid: a, vout: 1, spendingtxid: b },
            { txid: b, vout: 1 },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CoreRpcProvider({ url: "https://example.com" });
    expect(await provider.getMempoolSnapshot()).toEqual(new Set([a, b]));
    expect(
      await provider.getMempoolSpenders([
        { txid: a, vout: 1 },
        { txid: b, vout: 1 },
      ]),
    ).toEqual(
      new Map([
        [`${a}:1`, b],
        [`${b}:1`, null],
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([{}, ["bad"], [null]])(
    "rejects malformed membership without inventing absence: %j",
    async (result) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ result })),
      );
      await expect(
        new CoreRpcProvider({ url: "https://example.com" }).getMempoolSnapshot(),
      ).rejects.toBeInstanceOf(RpcError);
    },
  );
  it("rejects partial or reordered spender replies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          result: [
            { txid: b, vout: 1 },
            { txid: a, vout: 1 },
          ],
        }),
      ),
    );
    await expect(
      new CoreRpcProvider({ url: "https://example.com" }).getMempoolSpenders([
        { txid: a, vout: 1 },
        { txid: b, vout: 1 },
      ]),
    ).rejects.toBeInstanceOf(RpcError);
  });
});
