import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPortfolio } from "./portfolio";

afterEach(() => vi.unstubAllGlobals());
const page = (offset: number, more: boolean) => ({ ok: true, data: { walletScript: "script", holdings: [{ tokenId: `${offset}`, amountAtoms: "123", utxoCount: 2 }], tokenUtxos: [{ txid: `${offset}`, vout: 0, tokenId: "token", amountAtoms: "123" }], listings: [], fills: [], pagination: { limit: 500, offset, hasMore: { tokenUtxos: more } } } });
describe("complete wallet portfolio", () => {
  it("includes later pages before selecting inputs", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => page(0, true) }).mockResolvedValueOnce({ ok: true, json: async () => page(500, false) });
    vi.stubGlobal("fetch", fetch);
    const portfolio = await fetchPortfolio("address");
    expect(portfolio.tokenUtxos.map((u) => u.txid)).toEqual(["0", "500"]);
    expect(fetch.mock.calls[1]![0]).toContain("offset=500");
  });
  it("rejects oversized portfolios instead of reporting a partial balance", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => page(0, true) });
    vi.stubGlobal("fetch", fetch);
    await expect(fetchPortfolio("address")).rejects.toThrow("too many records");
    expect(fetch).toHaveBeenCalledTimes(20);
  });
  it("propagates failed pages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: { message: "retry" } }) }));
    await expect(fetchPortfolio("address")).rejects.toThrow("retry");
  });
});
