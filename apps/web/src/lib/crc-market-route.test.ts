import * as core from "@crclaunch/crc20-protocol";
import { describe, expect, it, vi } from "vitest";
import { crcMarketGet, crcMarketPost, type CrcMarketServices } from "./crc-market-route";

vi.mock("./crc-rate-limit", () => ({ checkCrcRateLimit: () => null }));

describe("CRC market route release boundary", () => {
  it("serves an empty disabled book without opening the database", async () => {
    const read = vi.fn(() => {
      throw new Error("database must stay closed");
    });
    const response = await crcMarketGet(
      new Request("http://localhost/api/crc/v1/market/listings"),
      "listings",
      false,
      read,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ active: false, listings: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects every mutation before opening services or parsing a body", async () => {
    const services = vi.fn(() => {
      throw new Error("services must stay closed");
    });
    const response = await crcMarketPost(
      new Request("http://localhost/api/crc/v1/market/reserve", {
        method: "POST",
        body: "not json",
      }),
      "reserve",
      false,
      services,
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("CRC_MARKET_DISABLED");
    expect(services).not.toHaveBeenCalled();
  });

  it("caps a chunked request without trusting Content-Length", async () => {
    const services = vi.fn(() => {
      throw new Error("services must stay closed");
    });
    const response = await crcMarketPost(
      new Request("http://localhost/api/crc/v1/market/reserve", {
        method: "POST",
        body: JSON.stringify({ filler: "x".repeat(300_001) }),
      }),
      "reserve",
      true,
      services,
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("REQUEST_TOO_LARGE");
    expect(services).not.toHaveBeenCalled();
  });

  it("checks buyer funding against token outputs from every Cove deployment", async () => {
    const tokenTxid = "a".repeat(64);
    const plainTxid = "b".repeat(64);
    const execute = vi.fn(async () => ({ rows: [{ key: `${tokenTxid}:0` }] }));
    const services = () =>
      ({ db: { execute }, network: "regtest", provider: {} }) as unknown as CrcMarketServices;
    const response = await crcMarketPost(
      new Request("http://localhost/api/crc/v1/market/funding-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outpoints: [
            { txid: tokenTxid, vout: 0 },
            { txid: plainTxid, vout: 1 },
          ],
        }),
      }),
      "funding-check",
      true,
      services,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.tokenFreeOutpoints).toEqual([{ txid: plainTxid, vout: 1 }]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("serializes fresh core offer projections with exact amounts", async () => {
    const script = `0014${"c".repeat(40)}`;
    const offer = {
      network: "regtest",
      deployTxid: "a".repeat(64),
      ticker: "TEST",
      listedInput: {
        txid: "b".repeat(64),
        vout: 1,
        sats: 1000n,
        atoms: 900719925474099300000n,
        scriptHex: script,
      },
      sellerScriptHex: script,
      priceSats: 5000n,
      expiryHeight: 200,
      publicKeyHex: "02" + "d".repeat(64),
      signatureHex: "",
      sellerWitnessHex: [],
      status: "open" as const,
    };
    const execute = vi.fn(async () => ({
      rows: [{ key: core.offerId(offer), value_json: core.encodeProtocolDto(offer) }],
    }));
    const response = await crcMarketGet(
      new Request("http://localhost/api/crc/v1/market/listings"),
      "listings",
      true,
      () => ({ db: { execute }, network: "regtest" }) as any,
    );
    expect(response.status).toBe(200);
    const listing = (await response.json()).data.listings[0];
    expect(listing.amountAtoms).toBe("900719925474099300000");
    expect(listing.expiresAtHeight).toBe("200");
    expect(listing.sellerAnchorTxid).toBe("b".repeat(64));
    expect(listing.protocolFeeSats).toBe(Number(core.marketFee(5000n)));
    expect(listing.coreOffer).toEqual(core.encodeProtocolDto(offer));
  });
});

for (const network of ["regtest", "signet", "testnet", "mainnet"] as const) {
  it(`allows read-only funding exclusion while ${network} marketplace mutations are paused`, async () => {
    const plainTxid = "b".repeat(64), carrierTxid = "a".repeat(64);
    const execute = vi.fn(async () => ({ rows: [{ key: `${carrierTxid}:0` }] }));
    const services = () => ({ db: { execute }, network, provider: {} }) as unknown as CrcMarketServices;
    const response = await crcMarketPost(new Request("http://localhost/api/crc/v1/market/funding-check", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ outpoints: [{ txid: carrierTxid, vout: 0 }, { txid: plainTxid, vout: 1 }] }),
    }), "funding-check", false, services);
    expect(response.status).toBe(200);
    expect((await response.json()).data.tokenFreeOutpoints).toEqual([{ txid: plainTxid, vout: 1 }]);
    expect(execute).toHaveBeenCalledOnce();
  });
}

it("seller availability is filtered, includes cancelPending, and explicitly reports truncation", async () => {
  const sellerScript = "0014" + "c".repeat(40);
  const rows=Array.from({length:101},(_,i)=>({key:String(i),value_json:core.encodeProtocolDto({network:"regtest",deployTxid:"a".repeat(64),ticker:"TEST",listedInput:{txid:i.toString(16).padStart(64,"0"),vout:0,sats:1000n,atoms:100n,scriptHex:sellerScript},sellerScriptHex:sellerScript,priceSats:5000n,expiryHeight:200,publicKeyHex:"02"+"d".repeat(64),signatureHex:"",sellerWitnessHex:[],status:i===0?"cancelPending":"open"})}));
  const execute=vi.fn(async (_query: unknown)=>({rows}));
  const response=await crcMarketGet(new Request(`http://localhost/api/crc/v1/market/listings?sellerScriptHex=${sellerScript}`),"listings",true,()=>({db:{execute},network:"regtest"}) as any);
  const data=(await response.json()).data;
  expect(data.truncated).toBe(true);expect(data.listings).toHaveLength(100);expect(data.unavailableOutpoints).toHaveLength(100);
  expect(data.listings[0].status).toBe("CANCEL_PENDING");
  const {PgDialect}=await import("drizzle-orm/pg-core");
  const query=new PgDialect().sqlToQuery(execute.mock.calls[0]![0] as any);
  expect(query.sql).toContain("cancelPending");expect(query.sql).toContain("LIMIT 101");expect(query.params).toContain(sellerScript);
});
