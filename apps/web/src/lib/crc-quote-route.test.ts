import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cursor: vi.fn(), asset: vi.fn(), registered: vi.fn(), balance: vi.fn() }));
vi.mock("./crc-server", () => ({ getCrcReadServices: () => ({ db: {}, network: "signet" }) }));
vi.mock("./crc-read", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readCrcCursor: mocks.cursor, readCrcQuoteAsset: mocks.asset, readCrcAsset: mocks.registered, readCrcBalance: mocks.balance };
});

import { crcQuoteRoute } from "./crc-quote-route";

const txid = "a".repeat(64);
const assetId = `signet:${txid}`;
const sellerAddress = "tb1qg358gsla30dtx228u3za8253zncpzdwkrl6eem";
const token = {
  assetId, mintedAtoms: "0", inventoryAtoms: "0", circulatingAtoms: "0",
  availability: "active", vault: { txid, vout: 1, btcSats: "330" },
  vaultAnchorSats: "330",
};
const request = (body: object) => new Request("http://localhost/api/crc/v1/backing/buy/quote", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  mocks.cursor.mockReset().mockResolvedValue({ height: "100", blockHash: "b".repeat(64) });
  mocks.asset.mockReset().mockResolvedValue(token);
  mocks.registered.mockReset().mockResolvedValue(token);
  mocks.balance.mockReset().mockResolvedValue(100_000_000_000n);
});

describe("CRC quote routes", () => {
  it("returns an exact DB-state buy quote bound to the vault outpoint", async () => {
    const response = await crcQuoteRoute(request({ assetId, amountAtoms: "100000000000" }), "buy");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, data: { indexedTip: { height: "100" }, quote: { operation: "mint", grossSats: "27", vaultOutpoint: `${txid}:1` } },
    });
    expect(mocks.asset).toHaveBeenCalledWith({}, "signet", txid);
    expect(mocks.balance).not.toHaveBeenCalled();
  });

  it("requires indexed seller balance and a network-valid payout script", async () => {
    mocks.asset.mockResolvedValue({ ...token, mintedAtoms: "100000000000", circulatingAtoms: "100000000000", vault: { ...token.vault, btcSats: "357" } });
    const over = await crcQuoteRoute(request({ assetId, amountAtoms: "200000000000", sellerAddress }), "sell");
    expect(over.status).toBe(400);
    expect((await over.json()).error.code).toBe("INSUFFICIENT_BALANCE");
    const valid = await crcQuoteRoute(request({ assetId, amountAtoms: "100000000000", sellerAddress }), "sell");
    expect(valid.status).toBe(200);
    expect((await valid.json()).data.quote).toMatchObject({ sellerPayoutSats: "294", walletTopUpSats: "1267" });
  });

  it("rejects external IDs, missing index, and unavailable vaults", async () => {
    const wrong = await crcQuoteRoute(request({ assetId: `mainnet:${txid}`, amountAtoms: "100000000000" }), "buy");
    expect(wrong.status).toBe(404);
    expect(mocks.asset).not.toHaveBeenCalled();
    mocks.cursor.mockResolvedValue(null);
    const rebuilding = await crcQuoteRoute(request({ assetId, amountAtoms: "100000000000" }), "buy");
    expect(rebuilding.status).toBe(503);
    mocks.cursor.mockResolvedValue({ height: "100", blockHash: "b".repeat(64) });
    mocks.asset.mockResolvedValue({ ...token, availability: "unavailable" });
    const unavailable = await crcQuoteRoute(request({ assetId, amountAtoms: "100000000000" }), "buy");
    expect(unavailable.status).toBe(503);
    mocks.asset.mockResolvedValue(null);
    const missingIntent = await crcQuoteRoute(request({ assetId, amountAtoms: "100000000000" }), "buy");
    expect(missingIntent.status).toBe(503);
    expect((await missingIntent.json()).error.code).toBe("INVALID_STATE");
  });
});
