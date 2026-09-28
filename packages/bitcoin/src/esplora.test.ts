import { afterEach, describe, expect, it, vi } from "vitest";
import { EsploraUtxoProvider } from "./esplora.js";

const address = "tb1qg358gsla30dtx228u3za8253zncpzdwkrl6eem";
const coin = { txid: "ab".repeat(32), vout: 0, value: 10_000, status: { confirmed: true, block_height: 123 } };

afterEach(() => vi.unstubAllGlobals());

describe("Esplora wallet coins", () => {
  it("resolves confirmations entirely through the address index without RPC", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([coin]))
      .mockResolvedValueOnce(new Response("125\n"));
    vi.stubGlobal("fetch", fetchMock);

    const coins = await new EsploraUtxoProvider("https://example.com", "signet").getUtxos(address);

    expect(coins[0]).toMatchObject({ valueSats: 10_000n, confirmations: 3 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://example.com/address/${address}/utxo`,
      "https://example.com/blocks/tip/height",
    ]);
  });

  it.each([{ coins: [] }, { coins: [{ ...coin, status: { confirmed: false } }] }])("does not fetch the tip for empty or unconfirmed results: %j", async ({ coins }) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(coins));
    vi.stubGlobal("fetch", fetchMock);
    const found = await new EsploraUtxoProvider("https://example.com").getUtxos(address);
    expect(found.every((u) => u.confirmations === 0)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves callers that supply a height", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([coin]));
    vi.stubGlobal("fetch", fetchMock);
    expect((await new EsploraUtxoProvider("https://example.com").getUtxos(address, 124))[0]?.confirmations).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["", "123garbage", "-1", "1.5", "9007199254740992"])("rejects an invalid tip: %j", async (tip) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json([coin])).mockResolvedValueOnce(new Response(tip)));
    await expect(new EsploraUtxoProvider("https://example.com").getUtxos(address)).rejects.toThrow("invalid tip height");
  });

  it("propagates a tip outage instead of inventing confirmations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json([coin])).mockResolvedValueOnce(new Response(null, { status: 503 })));
    await expect(new EsploraUtxoProvider("https://example.com").getUtxos(address)).rejects.toThrow("Esplora tip HTTP 503");
  });
});
