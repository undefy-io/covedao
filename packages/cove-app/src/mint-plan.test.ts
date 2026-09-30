import { describe, expect, it } from "vitest";
import { grossBuy } from "@crclaunch/cove-economics";
import { splitMint, MAX_MINT_PARTS } from "./mint-plan.js";

const T = 100_000_000n;
const limits = { maxMintAtoms: 1_000_000_000n * T, maxGrossSats: 200_000n, minGrossSats: 0n };

describe("splitMint", () => {
  it("keeps a mint under the limit in one part", () => {
    expect(splitMint({ supplyAtoms: 0n, amountAtoms: 3_000n * T, limits })).toEqual([3_000n * T]);
  });

  it("splits a mint over the limit into parts that each fit, in whole lots", () => {
    const amount = 2_000_000n * T;
    const parts = splitMint({ supplyAtoms: 0n, amountAtoms: amount, limits });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.reduce((a, p) => a + p, 0n)).toBe(amount);
    let supply = 0n;
    for (const p of parts) {
      expect(p % (1_000n * T)).toBe(0n);
      expect(grossBuy(supply / T, p / T)).toBeLessThanOrEqual(limits.maxGrossSats);
      supply += p;
    }
    // Every part but the last is as large as the limit allows.
    supply = 0n;
    for (const p of parts.slice(0, -1)) {
      expect(grossBuy(supply / T, p / T + 1_000n)).toBeGreaterThan(limits.maxGrossSats);
      supply += p;
    }
  });

  it("respects a token-count limit", () => {
    const parts = splitMint({
      supplyAtoms: 0n,
      amountAtoms: 3_000n * T,
      limits: { ...limits, maxMintAtoms: 1_000n * T },
    });
    expect(parts).toEqual([1_000n * T, 1_000n * T, 1_000n * T]);
  });

  it("refuses part lots, the public cap and too many parts", () => {
    expect(() => splitMint({ supplyAtoms: 0n, amountAtoms: 1_500n * T, limits })).toThrow(/lots/);
    expect(() => splitMint({ supplyAtoms: 0n, amountAtoms: 22_000_000n * T, limits })).toThrow(/cap/);
    expect(() =>
      splitMint({
        supplyAtoms: 0n,
        amountAtoms: BigInt(MAX_MINT_PARTS + 1) * 1_000n * T,
        limits: { ...limits, maxMintAtoms: 1_000n * T },
      }),
    ).toThrow(/more than/);
  });
});
