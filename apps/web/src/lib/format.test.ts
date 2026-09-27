import { describe, expect, it } from "vitest";
import { fmtTokens, fmtBtc, displayTokensToAtoms, atomsToDisplayTokens } from "./format";

/**
 * fmtTokens takes ATOMS. It previously skipped the 1e8 scaling, so the public
 * cap of 840,000,000 tokens rendered as "84000000B" across every page.
 */
describe("fmtTokens", () => {
  const T = 100_000_000n; // 1 token

  it("scales atoms to whole tokens before abbreviating", () => {
    expect(fmtTokens(840_000_000n * T)).toBe("840M");
    expect(fmtTokens(160_000_000n * T)).toBe("160M");
    expect(fmtTokens(1_000_000_000n * T)).toBe("1B");
  });

  it("keeps one decimal place", () => {
    expect(fmtTokens(1_500n * T)).toBe("1.5K");
    expect(fmtTokens(2_300_000n * T)).toBe("2.3M");
  });

  it("drops a trailing .0", () => {
    expect(fmtTokens(2_000n * T)).toBe("2K");
  });

  it("renders small amounts exactly", () => {
    expect(fmtTokens(0n)).toBe("0");
    expect(fmtTokens(1n * T)).toBe("1");
    expect(fmtTokens(999n * T)).toBe("999");
  });

  it("truncates sub-token dust rather than rounding up", () => {
    expect(fmtTokens(T - 1n)).toBe("0");
  });
});

describe("fmtBtc", () => {
  it("formats the full-subscription raise", () => {
    expect(fmtBtc(24_196_788n)).toBe("0.24196788 BTC");
  });

  it("trims trailing zeros and handles whole BTC", () => {
    expect(fmtBtc(100_000_000n)).toBe("1 BTC");
    expect(fmtBtc(0n)).toBe("0 BTC");
  });
});

describe("displayTokensToAtoms", () => {
  it("converts whole tokens", () => {
    expect(displayTokensToAtoms("1")).toBe("100000000");
    expect(displayTokensToAtoms("105")).toBe("10500000000");
  });

  it("converts the full 8 decimal places", () => {
    expect(displayTokensToAtoms("99630.95238095")).toBe("9963095238095");
  });

  it("pads a short fraction rather than misreading it", () => {
    // "0.1" is a tenth of a token, not 1 atom.
    expect(displayTokensToAtoms("0.1")).toBe("10000000");
  });

  it("rejects more precision than a token has, instead of silently truncating", () => {
    // The old behaviour dropped the trailing digit and took the value.
    expect(() => displayTokensToAtoms("99630.952380952")).toThrow(/8 decimal places/);
  });

  it("rejects junk", () => {
    expect(() => displayTokensToAtoms("abc")).toThrow(/invalid/);
    expect(() => displayTokensToAtoms("-5")).toThrow(/invalid/);
    expect(() => displayTokensToAtoms("")).toThrow(/invalid/);
  });
});

describe("atomsToDisplayTokens", () => {
  it("preserves the exact listed quantity when filling a buy amount", () => {
    for (const atoms of ["1", "100000000", "9963095238095"]) {
      expect(displayTokensToAtoms(atomsToDisplayTokens(atoms))).toBe(atoms);
    }
  });
});
