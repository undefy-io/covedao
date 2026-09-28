import { describe, expect, it, vi } from "vitest";
import {
  estimateVsize,
  outputVbytes,
  resolveMinerFee,
  FeeError,
  loadFeeRates,
  VB_INPUT_P2WPKH,
  VB_INPUT_VAULT,
  SCRIPT_BYTES_P2TR,
} from "./fees.js";

/**
 * The vbyte constants are a MEASUREMENT, not a guess. Each case below is a real
 * Cove transaction from a live chain, with its Bitcoin Core `vsize` recorded
 * alongside its exact input witnesses and output script lengths. If a constant
 * drifts, these fail — which is the point: a fee estimate that has quietly
 * stopped matching Bitcoin is how transactions get stranded.
 */
describe("estimateVsize against real Cove transactions", () => {
  it("reproduces a DEPLOY (1 P2WPKH in, 3 out) at 206 vbytes", () => {
    expect(
      estimateVsize({
        vaultInputs: 0,
        p2wpkhInputs: 1,
        // OP_RETURN 44, vault P2TR 34, change P2WPKH 22
        outputScriptBytes: [44, 34, 22],
      }),
    ).toBe(206);
  });

  // A vault spend weighs 99.5 vbytes and the constant rounds it up to 100, so
  // a transaction carrying one lands exactly one vbyte high. That direction is
  // deliberate: over-paying by one vbyte is invisible, under-paying is not.
  it("lands within one vbyte of a MINT with one funding input (measured 370)", () => {
    const estimate = estimateVsize({
      vaultInputs: 1,
      p2wpkhInputs: 1,
      // OP_RETURN 47, vault 34, carrier 22, fee 22, change 22
      outputScriptBytes: [47, 34, 22, 22, 22],
    });
    expect(estimate).toBeGreaterThanOrEqual(370);
    expect(estimate).toBeLessThanOrEqual(371);
  });

  it("lands within one vbyte of a MINT with two funding inputs (measured 438)", () => {
    const estimate = estimateVsize({
      vaultInputs: 1,
      p2wpkhInputs: 2,
      outputScriptBytes: [47, 34, 22, 22, 22],
    });
    expect(estimate).toBeGreaterThanOrEqual(438);
    expect(estimate).toBeLessThanOrEqual(439);
  });

  it("never under-estimates: erring high costs sats, erring low strands the transaction", () => {
    // Every measured case above is matched or exceeded, never undershot.
    for (const [measured, shape] of [
      [206, { vaultInputs: 0, p2wpkhInputs: 1, outputScriptBytes: [44, 34, 22] }],
      [370, { vaultInputs: 1, p2wpkhInputs: 1, outputScriptBytes: [47, 34, 22, 22, 22] }],
      [438, { vaultInputs: 1, p2wpkhInputs: 2, outputScriptBytes: [47, 34, 22, 22, 22] }],
    ] as const) {
      expect(estimateVsize(shape)).toBeGreaterThanOrEqual(measured);
    }
  });

  it("prices each part the way Bitcoin serializes it", () => {
    expect(VB_INPUT_P2WPKH).toBe(68); // 41 base + 108 witness bytes / 4
    expect(VB_INPUT_VAULT).toBe(100); // 41 base + 234 witness bytes / 4, rounded up
    expect(outputVbytes(SCRIPT_BYTES_P2TR)).toBe(43); // 8 value + 1 length + 34
    expect(outputVbytes(22)).toBe(31); // P2WPKH
  });
});

describe("resolveMinerFee", () => {
  const base = {
    vsize: 400,
    floorSatPerVb: 1n,
    ceilingSatPerVb: 500n,
    maxMinerFeeSats: 1_000_000n,
  };

  it("sizes the fee from the rate and the transaction", () => {
    const fee = resolveMinerFee({ ...base, rateSatPerVb: 12n });
    expect(fee.minerFeeSats).toBe(4_800n);
    expect(fee.effectiveSatPerVb).toBe(12n);
  });

  it("refuses a fee below the node's relay floor, and says what would work", () => {
    // The old flat 1,000 sats on a 400-vbyte transaction is 2 sat/vB.
    expect(() => resolveMinerFee({ ...base, floorSatPerVb: 8n, explicitSats: 1_000n })).toThrow(
      /would not confirm.*at least 3200 sats/s,
    );
  });

  it("accepts a flat fee when the mempool floor is low enough for it", () => {
    expect(resolveMinerFee({ ...base, explicitSats: 1_000n }).effectiveSatPerVb).toBe(2n);
  });

  it("refuses an absurd overpay as firmly as an underpay", () => {
    expect(() => resolveMinerFee({ ...base, rateSatPerVb: 900n })).toThrow(FeeError);
    expect(() => resolveMinerFee({ ...base, explicitSats: 900_000n })).toThrow(/ceiling/);
  });

  it("honours the absolute sat cap even at a legal rate", () => {
    expect(() =>
      resolveMinerFee({ ...base, maxMinerFeeSats: 3_000n, rateSatPerVb: 12n }),
    ).toThrow(/exceeds the 3000-sat cap/);
  });

  it("refuses a zero or negative rate rather than producing a free transaction", () => {
    expect(() => resolveMinerFee({ ...base, rateSatPerVb: 0n })).toThrow(/must be positive/);
  });

  it("refuses when neither a rate nor an amount is given", () => {
    expect(() => resolveMinerFee(base)).toThrow(/no fee rate or fee amount/);
  });
});

describe("loadFeeRates", () => {
  it("starts independent fee reads together and keeps tiers ordered", async () => {
    let releaseFloor!: (value: bigint) => void;
    const floor = new Promise<bigint>((resolve) => { releaseFloor = resolve; });
    const provider = {
      getMempoolMinFeeSatPerVb: vi.fn(() => floor),
      estimateFeeRateAt: vi.fn(async (blocks: number) => BigInt(20 - blocks)),
    } as unknown as Parameters<typeof loadFeeRates>[0];
    const pending = loadFeeRates(provider);
    expect(provider.estimateFeeRateAt).toHaveBeenCalledTimes(3);
    releaseFloor(10n);
    const rates = await pending;
    expect(rates.tiers.map((t) => t.satPerVb)).toEqual([10n, 17n, 19n]);
  });

  function fakeProvider(opts: {
    floor?: bigint;
    rates?: Record<number, bigint | null>;
    throwOnFloor?: boolean;
  }) {
    return {
      async getMempoolMinFeeSatPerVb() {
        if (opts.throwOnFloor) throw new Error("node down");
        return opts.floor ?? 1n;
      },
      async estimateFeeRateAt(blocks: number) {
        return opts.rates?.[blocks] ?? null;
      },
    } as unknown as Parameters<typeof loadFeeRates>[0];
  }

  it("uses the node's estimates when it has them", async () => {
    const rates = await loadFeeRates(fakeProvider({ rates: { 12: 3n, 3: 9n, 1: 20n } }));
    expect(rates.tiers.map((t) => t.satPerVb)).toEqual([3n, 9n, 20n]);
    expect(rates.estimated).toBe(false);
  });

  it("falls back and says so when the node has no fee history", async () => {
    const rates = await loadFeeRates(fakeProvider({}));
    expect(rates.estimated).toBe(true);
    expect(rates.tiers.map((t) => t.satPerVb)).toEqual([2n, 5n, 10n]);
  });

  it("lifts every tier to the current relay floor", async () => {
    // A filling mempool raises the floor above the node's own slow estimate.
    const rates = await loadFeeRates(fakeProvider({ floor: 15n, rates: { 12: 3n, 3: 9n, 1: 20n } }));
    expect(rates.tiers.map((t) => t.satPerVb)).toEqual([15n, 15n, 20n]);
    expect(rates.floorSatPerVb).toBe(15n);
  });

  it("never lets a faster tier cost less than a slower one", async () => {
    const rates = await loadFeeRates(fakeProvider({ rates: { 12: 40n, 3: 9n, 1: 5n } }));
    expect(rates.tiers.map((t) => t.satPerVb)).toEqual([40n, 40n, 40n]);
  });

  it("survives a node that cannot answer, rather than taking the whole app down", async () => {
    const rates = await loadFeeRates(fakeProvider({ throwOnFloor: true }));
    expect(rates.floorSatPerVb).toBe(1n);
  });

  it("labels the rates estimated when only the relay-floor lookup fails", async () => {
    const rates = await loadFeeRates(fakeProvider({ throwOnFloor: true, rates: { 12: 3n, 3: 9n, 1: 20n } }));
    expect(rates.estimated).toBe(true);
  });
});
