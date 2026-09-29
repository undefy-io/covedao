import { describe, expect, it } from "vitest";
import { affordableFeeTier, type FeeRatesResponse } from "./FeePicker";

const signetRates: FeeRatesResponse = {
  floorSatPerVb: "1",
  ceilingSatPerVb: "500",
  maxMinerFeeSats: "20000",
  estimated: false,
  typicalVsize: { DEPLOY: 274, BACKING_BUY: 414, REDEEM: 479, TRANSFER: 355 },
  tiers: [
    { key: "eco", label: "Eco", blocks: 12, satPerVb: "6" },
    { key: "standard", label: "Standard", blocks: 3, satPerVb: "500" },
    { key: "priority", label: "Priority", blocks: 1, satPerVb: "500" },
  ],
};

describe("affordableFeeTier", () => {
  it("selects the usable signet rate when Standard exceeds the miner-fee cap", () => {
    expect(affordableFeeTier(signetRates, "standard")?.key).toBe("eco");
    expect(761n * 6n).toBeLessThan(BigInt(signetRates.maxMinerFeeSats));
  });

  it("preserves a selected tier when it fits the cap", () => {
    const rates = {
      ...signetRates,
      tiers: signetRates.tiers.map((tier) =>
        tier.key === "standard" ? { ...tier, satPerVb: "20" } : tier,
      ),
    };
    expect(affordableFeeTier(rates, "standard")?.key).toBe("standard");
  });

  it("does not invent a rate when every tier exceeds the cap", () => {
    const rates = { ...signetRates, tiers: signetRates.tiers.slice(1) };
    expect(affordableFeeTier(rates, "standard")).toBeNull();
  });
});
