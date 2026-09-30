import { describe, expect, it } from "vitest";
import { applyBuy, createCurveState, quoteBuy } from "@crclaunch/crc20-curve";
import { parseCrc20Transaction } from "@crclaunch/crc20-base";
import {
  buildCoveV2Transfer,
  buildCoveV2MarketFill,
  buildCurveBuyV2,
  buildCurveSellV2,
  buildCurveDeployV2,
  buildUnsignedPsbt,
  selectCrcFunding,
  type CoveV2Input,
} from "../src/index.js";

const id = "99".repeat(32);
const seller = `0014${"11".repeat(20)}`;
const buyer = `0014${"22".repeat(20)}`;
const vault = `5120${"33".repeat(32)}`;
const protocol = `5120${"44".repeat(32)}`;
const creator = `5120${"55".repeat(32)}`;
const scripts = { seller, buyer, vault, protocol, creator };
const token = (byte: string, atoms: bigint, valueSats = 330, scriptHex = seller): CoveV2Input => ({
  txid: byte.repeat(64), vout: 0, valueSats, scriptHex, tokenAtoms: atoms, tokenDeploymentTxid: id,
});
const fund = (byte: string, valueSats: number, scriptHex = seller): CoveV2Input => ({
  txid: byte.repeat(64), vout: 0, valueSats, scriptHex, tokenAtoms: 0n,
});
const payload = (outputs: readonly { valueSats: number; scriptHex: string }[]) => {
  const parsed = parseCrc20Transaction(outputs);
  expect(parsed.status).toBe("valid");
  if (parsed.status !== "valid") throw new Error("invalid marker");
  return parsed.envelope.payload;
};

describe("CRC v2 token UTXO transaction topology", () => {
  it("writes a versioned deploy without changing the existing v1 builder", () => {
    const deploy = buildCurveDeployV2({ ticker: "COVE", maxAtoms: "2100000000000000", scripts, vaultAnchorSats: 330 });
    expect(payload(deploy.outputs)).toMatchObject({ cv: "cove-curve-v2" });
    expect(deploy.outputs[1]).toEqual({ valueSats: 330, scriptHex: vault });
  });

  it("consumes exact peer token outpoints and writes one residual token carrier", () => {
    const a = token("a", 600n);
    const b = token("b", 400n);
    const built = buildCoveV2Transfer({ ticker: "COVE", deploymentTxid: id, amountAtoms: 700n,
      tokenInputs: [a, b], recipientScriptHex: buyer, recipientSats: 330, tokenChangeSats: 330 });
    expect(payload(built.outputs)).toEqual({ p: "crc-20", op: "transfer", tick: "COVE", amt: "700", id, v: 2, ch: 2 });
    expect(built.outputs[1]).toEqual({ valueSats: 330, scriptHex: buyer });
    expect(built.outputs[2]).toEqual({ valueSats: 330, scriptHex: seller });
    expect(built.tokenChangeAtoms).toBe(300n);
    const psbt = buildUnsignedPsbt(built, [a, b, fund("c", 1_000)], 1_000);
    expect(psbt.txInputs.map((input) => input.hash.toString("hex"))).toEqual([a.txid, b.txid, "c".repeat(64)]);
    expect(() => buildUnsignedPsbt(built, [b, a, fund("c", 1_000)], 1_000)).toThrow(/token input|order/i);
    expect(() => buildUnsignedPsbt(built, [a, fund("c", 1_000), b], 1_000)).toThrow(/token input|prefix/i);
    expect(() => buildUnsignedPsbt(built, [a, b, token("c", 1n, 1_000)], 1_000)).toThrow(/token.*funding/i);
    expect(() => buildUnsignedPsbt(built, [a, b, { ...fund("c", 1_000), tokenDeploymentTxid: id }], 1_000)).toThrow(/token.*funding/i);
  });

  it("rejects missing token change, mixed assets, duplicate carriers and wrong owners", () => {
    const base = { ticker: "COVE", deploymentTxid: id, amountAtoms: 700n,
      recipientScriptHex: buyer, recipientSats: 330 };
    expect(() => buildCoveV2Transfer({ ...base, tokenInputs: [token("a", 1_000n)] })).toThrow(/token change/i);
    expect(() => buildCoveV2Transfer({ ...base, tokenInputs: [token("a", 1_000n)], tokenChangeSats: 1 })).toThrow(/dust/i);
    expect(() => buildCoveV2Transfer({ ...base, tokenInputs: [token("a", 600n)] })).toThrow(/insufficient/i);
    expect(() => buildCoveV2Transfer({ ...base, tokenInputs: [token("a", 600n), token("a", 400n)], tokenChangeSats: 330 })).toThrow(/duplicate/i);
    expect(() => buildCoveV2Transfer({ ...base, tokenInputs: [token("a", 600n), token("b", 400n, 330, buyer)], tokenChangeSats: 330 })).toThrow(/owner/i);
    expect(() => buildCoveV2Transfer({ ...base, tokenInputs: [token("a", 600n), { ...token("b", 400n), tokenDeploymentTxid: "88".repeat(32) }], tokenChangeSats: 330 })).toThrow(/asset/i);
    expect(() => buildCoveV2Transfer({ ...base, amountAtoms: 1_000n, tokenInputs: [token("a", 1_000n)], tokenChangeSats: 330 })).toThrow(/token change/i);
  });

  it("keeps market exact-fill token outpoint ahead of buyer funds and binds carrier sats into payout", () => {
    const listed = token("a", 1_000n, 670);
    const fill = buildCoveV2MarketFill({ ticker: "COVE", deploymentTxid: id, listedInput: listed,
      buyerScriptHex: buyer, recipientSats: 330, sellerNetPriceSats: 10_000,
      protocolScriptHex: protocol, protocolFeeSats: 1_000, buyerChangeSats: 1_000 });
    expect(payload(fill.outputs)).toEqual({ p: "crc-20", op: "transfer", tick: "COVE", amt: "1000", id, v: 2 });
    expect(fill.outputs.slice(1)).toEqual([
      { valueSats: 330, scriptHex: buyer },
      { valueSats: 10_670, scriptHex: seller },
      { valueSats: 1_000, scriptHex: protocol },
      { valueSats: 1_000, scriptHex: buyer },
    ]);
    expect(() => buildUnsignedPsbt(fill, [fund("b", 13_330, buyer), listed], 1_000)).toThrow(/token input|order/i);
    expect(buildUnsignedPsbt(fill, [listed, fund("b", 13_330, buyer)], 1_000).txInputs).toHaveLength(2);
    expect(() => buildCoveV2MarketFill({ ticker: "COVE", deploymentTxid: id,
      listedInput: { ...listed, tokenAtoms: 0n }, buyerScriptHex: buyer, recipientSats: 330,
      sellerNetPriceSats: 10_000, protocolScriptHex: protocol, protocolFeeSats: 1_000 })).toThrow(/token/i);
  });

  it("uses the same outpoint-bound transfer for escrow deposit and withdrawal", () => {
    const escrow = `5120${"66".repeat(32)}`;
    const deposit = buildCoveV2Transfer({ ticker: "COVE", deploymentTxid: id,
      amountAtoms: 1_000n, tokenInputs: [token("a", 1_000n)],
      recipientScriptHex: escrow, recipientSats: 330 });
    expect(payload(deposit.outputs)).toMatchObject({ v: 2, amt: "1000" });
    expect(deposit.outputs[1]?.scriptHex).toBe(escrow);
    const deposited = { ...token("d", 1_000n, 330, escrow), vout: 1 };
    const withdrawal = buildCoveV2Transfer({ ticker: "COVE", deploymentTxid: id,
      amountAtoms: 1_000n, tokenInputs: [deposited],
      recipientScriptHex: seller, recipientSats: 330 });
    expect(withdrawal.requiredInputs).toEqual([deposited]);
    expect(withdrawal.outputs[1]?.scriptHex).toBe(seller);
    expect(() => buildUnsignedPsbt(withdrawal, [token("a", 1_000n)], 0)).toThrow(/token input|order/i);
  });

  it("mints to recipient and accounts for vault inventory on subsequent buy", () => {
    const state = createCurveState(`${"aa".repeat(32)}:1`, 330n);
    const vaultInput = { ...token("a", 0n, 330, vault), txid: "aa".repeat(32), vout: 1,
      tokenDeploymentTxid: undefined };
    const mint = buildCurveBuyV2({ ticker: "COVE", deploymentTxid: id, state,
      amountTokens: 1_000n, scripts, recipientSats: 330, vaultInput });
    expect(payload(mint.outputs)).toMatchObject({ op: "mint", v: 2 });
    expect(mint.outputs[1]?.scriptHex).toBe(buyer);
    expect(mint.requiredInputs).toEqual([vaultInput]);
    expect(buildUnsignedPsbt(mint, [vaultInput, fund("c", mint.requiredFundingSats + 1_000, buyer)], 1_000).txInputs).toHaveLength(2);
    const inventoryState = { ...state, mintedAtoms: 1_000n * 100_000_000n,
      vaultAtoms: 1_000n * 100_000_000n };
    expect(() => buildCurveBuyV2({ ticker: "COVE", deploymentTxid: id, state: inventoryState,
      amountTokens: 1_000n, scripts, recipientSats: 330, vaultInput })).toThrow(/vault inventory|token/i);
  });

  it("sells from exact token carriers, preserving remainder in a separate output", () => {
    const initial = createCurveState(`${"bb".repeat(32)}:1`, 330n);
    const buy = quoteBuy(initial, 41_000n);
    const state = applyBuy(initial, { amountAtoms: buy.amountAtoms,
      previousVaultOutpoint: initial.vaultOutpoint, nextVaultOutpoint: `${"aa".repeat(32)}:1`,
      nextVaultSats: initial.vaultSats + buy.grossSats,
      protocolFeeSats: buy.protocolFeeSats, creatorFeeSats: buy.creatorFeeSats });
    const vaultInput = { ...token("a", 0n, Number(state.vaultSats), vault), txid: "aa".repeat(32), vout: 1,
      tokenDeploymentTxid: undefined };
    const sellerInput = token("b", 40_001n * 100_000_000n);
    const sell = buildCurveSellV2({ ticker: "COVE", deploymentTxid: id, state,
      amountTokens: 40_000n, scripts, vaultInput, sellerTokenInputs: [sellerInput], tokenChangeSats: 330 });
    expect(payload(sell.outputs)).toMatchObject({ op: "transfer", v: 2, ch: 4 });
    expect(sell.outputs[1]?.scriptHex).toBe(vault);
    expect(sell.outputs[4]).toEqual({ valueSats: 330, scriptHex: seller });
    expect(sell.requiredInputs).toEqual([vaultInput, sellerInput]);
    expect(buildUnsignedPsbt(sell, [vaultInput, sellerInput,
      fund("c", sell.requiredFundingSats + 1_000)], 1_000).txInputs).toHaveLength(3);
    expect(() => buildUnsignedPsbt(sell, [vaultInput, sellerInput,
      fund("c", sell.requiredFundingSats + 999)], 1_000)).toThrow(/fund outputs/i);
  });

  it("funding selector never promotes token carriers into ordinary BTC candidates", () => {
    expect(() => selectCrcFunding({ mandatoryInputs: [fund("a", 330, vault)],
      candidates: [token("b", 1_000n, 10_000)], outputsSats: 9_000,
      minerFeeSats: 1_000, changeScriptHex: seller })).toThrow(/token.*funding/i);
  });
});
