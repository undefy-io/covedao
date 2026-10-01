import { describe, expect, it } from "vitest";
import { crcMarketAvailable } from "./crc-market-availability";

describe("CRC marketplace test release gate", () => {
  const ready = { network: "signet" as const, protocolMode: "crc20" as const,
    tradingActive: true, testingEnabled: true };

  it("opens the market for the signet wallet canary", () => {
    expect(crcMarketAvailable(ready)).toBe(true);
    expect(crcMarketAvailable({ ...ready, network: "regtest" })).toBe(true);
  });

  it("stays closed without an explicit test release or active CRC trading", () => {
    expect(crcMarketAvailable({ ...ready, testingEnabled: false })).toBe(false);
    expect(crcMarketAvailable({ ...ready, tradingActive: false })).toBe(false);
    expect(crcMarketAvailable({ ...ready, protocolMode: "legacy" })).toBe(false);
  });

  it("never opens mainnet or testnet through the signet test switch", () => {
    expect(crcMarketAvailable({ ...ready, network: "mainnet" })).toBe(false);
    expect(crcMarketAvailable({ ...ready, network: "testnet" })).toBe(false);
  });
});
