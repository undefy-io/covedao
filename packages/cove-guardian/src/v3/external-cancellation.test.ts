import { afterEach, describe, expect, it, vi } from "vitest";
import { getRpcOperationSignal, withRpcDeadline } from "@crclaunch/bitcoin";
import { ordAssetLookup } from "./funding.js";
import { HttpGuardianTransport } from "./guardianApi.js";

const outpoint = { txid: "aa".repeat(32), vout: 0 };
const clean = () => new Response(JSON.stringify({ indexed: true, inscriptions: [], runes: {} }));
afterEach(() => vi.unstubAllGlobals());

describe("external operation cancellation", () => {
  it("nested deadlines retain the parent's cancellation", async () => {
    const parent = new AbortController();
    await withRpcDeadline(parent.signal, () => withRpcDeadline(AbortSignal.timeout(1000), async () => {
      parent.abort(new Error("parent ended"));
      expect(() => getRpcOperationSignal()?.throwIfAborted()).toThrow("parent ended");
    }));
  });

  it("cancels queued ord budget acquisition without starting fetch", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => clean());
    const budget = { acquire: vi.fn((signal: AbortSignal) => new Promise<() => Promise<void>>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) };
    const lookup = ordAssetLookup("https://ord.test", { budget, fetchImpl });
    const pending = withRpcDeadline(controller.signal, () => lookup.describeAssets(outpoint));
    await vi.waitFor(() => expect(budget.acquire).toHaveBeenCalledOnce());
    controller.abort(new Error("disconnected"));
    await expect(pending).rejects.toThrow("disconnected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cancels a stalled ord response body and releases its lease", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const release = vi.fn(async () => {});
    const lookup = ordAssetLookup("https://ord.test", {
      budget: { acquire: async () => release },
      fetchImpl: vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    });
    const pending = withRpcDeadline(controller.signal, () => lookup.describeAssets(outpoint));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("disconnected"));
    await expect(pending).rejects.toThrow("disconnected");
    expect(cancel).toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds chunked ord bodies and fails closed on malformed JSON", async () => {
    const release = vi.fn(async () => {});
    const lookup = ordAssetLookup("https://ord.test", {
      maxResponseBytes: 32,
      budget: { acquire: async () => release },
      fetchImpl: vi.fn(async () => new Response(new ReadableStream({ start(stream) {
        stream.enqueue(new Uint8Array(20)); stream.enqueue(new Uint8Array(20)); stream.close();
      } }))),
    });
    await expect(lookup.describeAssets(outpoint)).rejects.toThrow("too large");
    expect(release).toHaveBeenCalledOnce();
    await expect(ordAssetLookup("https://ord.test", { fetchImpl: async () => new Response("{") }).describeAssets(outpoint)).rejects.toThrow();
  });

  it("bounds local ord concurrency and promptly removes aborted waiters", async () => {
    const ends: (() => void)[] = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => ends.push(() => resolve(clean()))));
    const lookup = ordAssetLookup("https://ord.test", { fetchImpl });
    const active = Array.from({ length: 4 }, () => lookup.describeAssets(outpoint));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    const controller = new AbortController();
    const waiting = withRpcDeadline(controller.signal, () => lookup.describeAssets(outpoint));
    controller.abort(new Error("cancel queued"));
    await expect(waiting).rejects.toThrow("cancel queued");
    ends.forEach((end) => end());
    await Promise.all(active);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("remote Guardian inherits operation cancellation during response reads", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }))));
    const transport = new HttpGuardianTransport("https://guardian.test", "test-token");
    const pending = withRpcDeadline(controller.signal, () => transport.health());
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("client left"));
    await expect(pending).rejects.toThrow("client left");
    expect(cancel).toHaveBeenCalled();
  });

  it("the enclosing deadline cancels ord before its longer local timeout", async () => {
    const release = vi.fn(async () => {});
    const lookup = ordAssetLookup("https://ord.test", {
      timeoutMs: 5000,
      budget: { acquire: async () => release },
      fetchImpl: async () => new Response(new ReadableStream()),
    });
    await expect(withRpcDeadline(AbortSignal.timeout(20), () => lookup.describeAssets(outpoint))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds remote Guardian bodies even without a Content-Length header", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new Uint8Array(1_100_000));
      stream.enqueue(new Uint8Array(1_100_000));
    }, cancel }))));
    await expect(new HttpGuardianTransport("https://guardian.test", "token").health()).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalled();
  });
});
