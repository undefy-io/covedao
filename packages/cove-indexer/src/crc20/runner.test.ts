import { describe, expect, it } from "vitest";
import { assertCrcChainIdentity, firstCrcHeight } from "./runner.js";

describe("CRC worker chain gate", () => {
  it("rejects an RPC node on the wrong Bitcoin network", () => {
    expect(() => assertCrcChainIdentity("signet", "main")).toThrow();
    expect(() => assertCrcChainIdentity("mainnet", "main")).not.toThrow();
    expect(() => assertCrcChainIdentity("testnet", "test")).not.toThrow();
  });

  it("starts at activation and resumes exactly after the committed cursor", () => {
    expect(firstCrcHeight(null, 900)).toBe(900);
    expect(firstCrcHeight(null, 0)).toBe(1);
    expect(firstCrcHeight(901, 900)).toBe(902);
    expect(() => firstCrcHeight(899, 900)).toThrow();
  });
});
