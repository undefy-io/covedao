import { describe, expect, it } from "vitest";
import { requiredBackingSats } from "@crclaunch/cove-economics";
import {
  applyBuy,
  applySell,
  createCurveState,
  isCoveCurveDeploy,
  quoteBuy,
  quoteSell,
  requiredBacking,
  type CurveState,
} from "../src/index.js";

const A = 100_000_000n;

function buy(state: CurveState, tokens: bigint, nextOutpoint: string) {
  const quote = quoteBuy(state, tokens);
  return applyBuy(state, {
    amountAtoms: tokens * A,
    previousVaultOutpoint: state.vaultOutpoint,
    nextVaultOutpoint: nextOutpoint,
    nextVaultSats: state.vaultSats + quote.grossSats,
    protocolFeeSats: quote.protocolFeeSats,
    creatorFeeSats: quote.creatorFeeSats,
  });
}

function sell(state: CurveState, tokens: bigint, nextOutpoint: string) {
  const quote = quoteSell(state, tokens);
  return applySell(state, {
    amountAtoms: tokens * A,
    previousVaultOutpoint: state.vaultOutpoint,
    nextVaultOutpoint: nextOutpoint,
    nextVaultSats: state.vaultSats - quote.grossSats,
    protocolFeeSats: quote.protocolFeeSats,
    sellerPayoutSats: quote.sellerPayoutSats,
    walletTopUpSats: quote.walletTopUpSats,
    payoutDustSats: 330n,
  });
}

describe("CRC-first Cove curve state", () => {
  it("does not apply curve rules to external standard CRC assets", () => {
    expect(isCoveCurveDeploy({ p: "crc-20", op: "deploy", tick: "LEAF", type: "bonding" })).toBe(
      false,
    );
    expect(
      isCoveCurveDeploy({ p: "crc-20", op: "deploy", tick: "COVE", cv: "cove-curve-v3" }),
    ).toBe(false);
    expect(isCoveCurveDeploy({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v3" })).toBe(true);
    expect(isCoveCurveDeploy({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" })).toBe(false);
    expect(isCoveCurveDeploy({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000001", cv: "cove-curve-v3" })).toBe(false);
    expect(isCoveCurveDeploy({ p: "crc-20", op: "mint", tick: "COVE", cv: "cove-curve-v3" })).toBe(
      false,
    );
  });
  it("starts with zero minted and vault inventory; fees are outside backing", () => {
    const state = createCurveState("deploy:1", 330n);
    const q = quoteBuy(state, 100_000n);
    expect(q).toMatchObject({
      operation: "mint",
      amountAtoms: 100_000n * A,
      grossSats: 2_700n,
      protocolFeeSats: 6_203n,
      creatorFeeSats: 1_350n,
      buyerTotalSats: 10_253n,
    });
    const next = buy(state, 100_000n, "buy:1");
    expect(next.mintedAtoms).toBe(100_000n * A);
    expect(next.circulatingAtoms).toBe(next.mintedAtoms);
    expect(next.vaultAtoms).toBe(0n);
    expect(next.vaultSats).toBe(3_030n);
  });

  it("pins the Cove price step and fee schedule at a stage boundary", () => {
    const initial = createCurveState("deploy:1", 330n);
    const first = buy(initial, 100_000n, "first:1");
    expect(first.vaultSats).toBe(3_030n);
    expect(quoteBuy(first, 1_000n)).toMatchObject({
      grossSats: 54n,
      protocolFeeSats: 5_015n,
      creatorFeeSats: 546n,
    });
    const second = buy(first, 1_000n, "second:1");
    expect(second.vaultSats).toBe(3_084n);
    expect(quoteSell(second, 1_000n)).toMatchObject({ grossSats: 54n, protocolFeeSats: 1_000n });
  });

  it("matches the reserve at every stage boundary", () => {
    for (let stage = 0n; stage <= 210n; stage++) {
      const supply = stage * 100_000n;
      expect(requiredBacking(supply)).toBe(requiredBackingSats(supply));
      if (stage < 210n) expect(requiredBacking(supply + 1_000n)).toBe(requiredBackingSats(supply + 1_000n));
    }
  });

  it("sells partial and full amounts into vault inventory, then resells before minting", () => {
    const minted = buy(createCurveState("deploy:1", 330n), 100_000n, "buy:1");
    const partlySold = sell(minted, 40_000n, "sell:1");
    expect(partlySold.mintedAtoms).toBe(100_000n * A);
    expect(partlySold.circulatingAtoms).toBe(60_000n * A);
    expect(partlySold.vaultAtoms).toBe(40_000n * A);
    expect(partlySold.vaultSats).toBe(330n + 1_620n);
    const resold = buy(partlySold, 40_000n, "resell:1");
    expect(resold.mintedAtoms).toBe(minted.mintedAtoms);
    expect(resold.vaultAtoms).toBe(0n);
    expect(resold.vaultSats).toBe(minted.vaultSats);
    const fullySold = sell(resold, 100_000n, "sell:2");
    expect(fullySold.circulatingAtoms).toBe(0n);
    expect(fullySold.vaultAtoms).toBe(fullySold.mintedAtoms);
    expect(fullySold.vaultSats).toBe(330n);
  });

  it("keeps cumulative minted under the standard cap and splits inventory-crossing buys", () => {
    const state = createCurveState("deploy:1", 330n);
    expect(() => quoteBuy(state, 21_001_000n)).toThrow(/cap/i);
    const full = buy(state, 21_000_000n, "buy:full");
    expect(full.mintedAtoms).toBe(21_000_000n * A);
    expect(() => quoteBuy(full, 1_000n)).toThrow(/cap/i);
    const sold = sell(full, 1_000n, "sell:1");
    expect(quoteBuy(sold, 1_000n).operation).toBe("transfer");
    expect(() => quoteBuy(sold, 2_000n)).toThrow(/split/i);
  });

  it("requires whole 1000-token lots, rejects zero, negative and excess redemptions", () => {
    const state = createCurveState("deploy:1", 330n);
    for (const amount of [0n, -1n, 999n, 1_001n]) {
      expect(() => quoteBuy(state, amount)).toThrow();
    }
    expect(() => quoteSell(state, 1_000n)).toThrow(/balance|supply/i);
    const minted = buy(state, 1_000n, "buy:1");
    expect(() => quoteSell(minted, 2_000n)).toThrow(/balance|supply/i);
  });

  it("charges rounding and dust top-up explicitly on the smallest sell", () => {
    const minted = buy(createCurveState("deploy:1", 330n), 1_000n, "buy:1");
    const q = quoteSell(minted, 1_000n);
    expect(q).toMatchObject({
      grossSats: 27n,
      protocolFeeSats: 1_000n,
      sellerPayoutSats: 330n,
      walletTopUpSats: 1_303n,
    });
    expect(q.sellerNetSats).toBe(-973n);
    expect(sell(minted, 1_000n, "sell:1").vaultSats).toBe(330n);
  });

  it("refuses stale competing transitions and incorrect backing or fee outputs", () => {
    const state = createCurveState("deploy:1", 330n);
    const q = quoteBuy(state, 1_000n);
    const good = {
      amountAtoms: 1_000n * A,
      previousVaultOutpoint: state.vaultOutpoint,
      nextVaultOutpoint: "buy:1",
      nextVaultSats: state.vaultSats + q.grossSats,
      protocolFeeSats: q.protocolFeeSats,
      creatorFeeSats: q.creatorFeeSats,
    };
    const accepted = applyBuy(state, good);
    expect(() => applyBuy(accepted, { ...good, nextVaultOutpoint: "buy:2" })).toThrow(/stale/i);
    expect(() => applyBuy(state, { ...good, nextVaultSats: good.nextVaultSats - 1n })).toThrow(
      /backing/i,
    );
    expect(() => applyBuy(state, { ...good, creatorFeeSats: good.creatorFeeSats - 1n })).toThrow(
      /creator/i,
    );
    expect(() => applyBuy(state, { ...good, protocolFeeSats: good.protocolFeeSats - 1n })).toThrow(
      /protocol/i,
    );
    expect(state.circulatingAtoms).toBe(0n);
  });

  it("refuses a sell that underfunds the seller or extracts one extra sat from backing", () => {
    const minted = buy(createCurveState("deploy:1", 330n), 1_000n, "buy:1");
    const q = quoteSell(minted, 1_000n);
    const sale = {
      amountAtoms: 1_000n * A,
      previousVaultOutpoint: minted.vaultOutpoint,
      nextVaultOutpoint: "sell:1",
      nextVaultSats: minted.vaultSats - q.grossSats,
      protocolFeeSats: q.protocolFeeSats,
      sellerPayoutSats: q.sellerPayoutSats,
      walletTopUpSats: q.walletTopUpSats,
      payoutDustSats: 330n,
    };
    expect(() => applySell(minted, { ...sale, nextVaultSats: sale.nextVaultSats - 1n })).toThrow(
      /backing/i,
    );
    expect(() =>
      applySell(minted, { ...sale, sellerPayoutSats: sale.sellerPayoutSats - 1n }),
    ).toThrow(/payout/i);
    expect(() =>
      applySell(minted, { ...sale, walletTopUpSats: sale.walletTopUpSats - 1n }),
    ).toThrow(/wallet/i);
    expect(minted.vaultSats).toBe(357n);
  });

  it("conserves supply and backing over a repeated buy/sell sequence", () => {
    let state = createCurveState("deploy:1", 330n);
    state = buy(state, 100_000n, "b1");
    state = buy(state, 100_000n, "b2");
    state = sell(state, 30_000n, "s1");
    state = sell(state, 70_000n, "s2");
    state = buy(state, 60_000n, "b3");
    state = buy(state, 40_000n, "b4");
    state = sell(state, 200_000n, "s3");
    expect(state.circulatingAtoms).toBe(0n);
    expect(state.vaultAtoms).toBe(state.mintedAtoms);
    expect(state.vaultSats).toBe(state.vaultAnchorSats);
  });
});
