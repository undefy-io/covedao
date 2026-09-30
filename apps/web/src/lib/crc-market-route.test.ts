import { describe, expect, it, vi } from "vitest";
import { crcMarketGet, crcMarketPost, type CrcMarketServices } from "./crc-market-route";

vi.mock("./crc-rate-limit", () => ({ checkCrcRateLimit: () => null }));

describe("CRC market route release boundary", () => {
  it("serves an empty disabled book without opening the database", async () => {
    const read = vi.fn(() => { throw new Error("database must stay closed"); });
    const response = await crcMarketGet(new Request("http://localhost/api/crc/v1/market/listings"),
      "listings", false, read);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ active: false, listings: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects every mutation before opening services or parsing a body", async () => {
    const services = vi.fn(() => { throw new Error("services must stay closed"); });
    const response = await crcMarketPost(new Request("http://localhost/api/crc/v1/market/reserve", {
      method: "POST", body: "not json",
    }), "reserve", false, services);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("CRC_MARKET_DISABLED");
    expect(services).not.toHaveBeenCalled();
  });

  it("caps a chunked request without trusting Content-Length", async () => {
    const services = vi.fn(() => { throw new Error("services must stay closed"); });
    const response = await crcMarketPost(new Request("http://localhost/api/crc/v1/market/reserve", {
      method: "POST", body: JSON.stringify({ filler: "x".repeat(300_001) }),
    }), "reserve", true, services);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("REQUEST_TOO_LARGE");
    expect(services).not.toHaveBeenCalled();
  });

  it("checks buyer funding against token outputs from every Cove deployment", async () => {
    const tokenTxid = "a".repeat(64);
    const plainTxid = "b".repeat(64);
    const execute = vi.fn(async () => ({ rows: [{ txid: tokenTxid, vout: 0 }] }));
    const services = () => ({ db: { execute }, network: "regtest",
      provider: {} }) as unknown as CrcMarketServices;
    const response = await crcMarketPost(new Request("http://localhost/api/crc/v1/market/funding-check", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ outpoints: [{ txid: tokenTxid, vout: 0 },
        { txid: plainTxid, vout: 1 }] }),
    }), "funding-check", true, services);
    expect(response.status).toBe(200);
    expect((await response.json()).data.tokenFreeOutpoints).toEqual([{ txid: plainTxid, vout: 1 }]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("serializes full seller listing terms with exact decimal amounts", async () => {
    const script = `0014${"c".repeat(40)}`;
    const execute = vi.fn(async () => ({ rows: [{
      id: "11111111-1111-4111-8111-111111111111", fill_id: "22222222-2222-4222-8222-222222222222",
      listing_id: "11111111-1111-4111-8111-111111111111",
      buyer_signed_psbt_base64: "cHNidP8=", expires_at: new Date("2027-01-01T00:00:00.000Z"),
      network: "regtest", deploy_txid: "a".repeat(64), ticker: "COVE",
      seller_script_hex: script, seller_payout_script_hex: script,
      seller_anchor_txid: "b".repeat(64), seller_anchor_vout: 0, seller_anchor_sats: "1000",
      amount_atoms: "900719925474099300000", price_sats: "5000", protocol_fee_sats: "1000",
      expires_at_height: "9007199254740993", status: "RESERVED",
    }] }));
    const services = () => ({ db: { execute }, network: "regtest",
      provider: {} }) as unknown as CrcMarketServices;
    const response = await crcMarketPost(new Request("http://localhost/api/crc/v1/market/seller-requests", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sellerScriptHex: script }),
    }), "seller-requests", true, services);
    expect(response.status).toBe(200);
    const request = (await response.json()).data.requests[0];
    expect(request.listing.amountAtoms).toBe("900719925474099300000");
    expect(request.listing.expiresAtHeight).toBe("9007199254740993");
    expect(request.listing.sellerAnchorTxid).toBe("b".repeat(64));
  });
});
