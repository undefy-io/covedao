import { describe, expect, it } from "vitest";
import { applyBuy, createCurveState, quoteBuy } from "@crclaunch/crc20-curve";
import { parseCrc20Transaction } from "@crclaunch/crc20-base";
import {
  buildCoveV3MarketFill,
  buildCoveV3Transfer,
  buildCurveBuyV3,
  buildCurveDeployV3,
  buildCurveSellV3,
  buildUnsignedPsbt,
  type CoveTokenInput,
} from "../src/index.js";

const id = "99".repeat(32);
const seller = `0014${"11".repeat(20)}`;
const buyer = `0014${"22".repeat(20)}`;
const vault = `5120${"33".repeat(32)}`;
const protocol = `5120${"44".repeat(32)}`;
const creator = `5120${"55".repeat(32)}`;
const scripts = { seller, buyer, vault, protocol, creator };
const listed: CoveTokenInput = {
  txid: "aa".repeat(32), vout: 0, valueSats: 670, scriptHex: seller,
  tokenAtoms: 1_000n, tokenDeploymentTxid: id,
};

function markerJson(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const opcode = script[1] === 0x4c ? 3 : 2;
  return script.subarray(opcode).toString("utf8");
}

describe("Cove v3 Garden wire shape", () => {
  it("identifies the Cove curve deployment", () => {
    const deploy = buildCurveDeployV3({ ticker: "COVE", maxAtoms: "2100000000000000",
      scripts, vaultAnchorSats: 330 });
    expect(JSON.parse(markerJson(deploy.outputs[0]!.scriptHex))).toMatchObject({
      p: "crc-20", op: "deploy", tick: "COVE", cv: "cove-curve-v3",
    });
  });

  it("uses the Garden amountless mint marker with recipient immediately after it", () => {
    const state = createCurveState(`${"aa".repeat(32)}:1`, 330n);
    const vaultInput: CoveTokenInput = { txid: "aa".repeat(32), vout: 1,
      valueSats: 330, scriptHex: vault, tokenAtoms: 0n };
    const built = buildCurveBuyV3({ ticker: "COVE", deploymentTxid: id, state,
      amountTokens: 1_000n, scripts, recipientSats: 330, vaultInput });
    expect(markerJson(built.outputs[0]!.scriptHex)).toBe('{"p":"crc-20","op":"mint","tick":"COVE"}');
    expect(built.outputs[1]).toEqual({ valueSats: 330, scriptHex: buyer });
    expect(parseCrc20Transaction(built.outputs)).toMatchObject({ status: "valid", envelope: { kind: "mint" } });
  });

  it("uses four-field transfer JSON while preserving exact token input and change", () => {
    const built = buildCoveV3Transfer({ ticker: "COVE", deploymentTxid: id,
      amountAtoms: 700n, tokenInputs: [listed], recipientScriptHex: buyer,
      recipientSats: 330, tokenChangeSats: 340 });
    expect(markerJson(built.outputs[0]!.scriptHex)).toBe('{"p":"crc-20","op":"transfer","tick":"COVE","amt":"700"}');
    expect(built.outputs[1]).toEqual({ valueSats: 330, scriptHex: buyer });
    expect(built.outputs[2]).toEqual({ valueSats: 340, scriptHex: seller });
    expect(built.tokenChangeAtoms).toBe(300n);
    expect(built.requiredInputs).toEqual([listed]);
  });

  it("keeps the sell vault outpoint and seller carrier mandatory with a four-field marker", () => {
    const initial = createCurveState(`${"cc".repeat(32)}:1`, 330n);
    const buy = quoteBuy(initial, 41_000n);
    const state = applyBuy(initial, { amountAtoms: buy.amountAtoms,
      previousVaultOutpoint: initial.vaultOutpoint,
      nextVaultOutpoint: `${"dd".repeat(32)}:1`,
      nextVaultSats: initial.vaultSats + buy.grossSats,
      protocolFeeSats: buy.protocolFeeSats, creatorFeeSats: buy.creatorFeeSats });
    const vaultInput: CoveTokenInput = { txid: "dd".repeat(32), vout: 1,
      valueSats: Number(state.vaultSats), scriptHex: vault, tokenAtoms: 0n };
    const sellerInput = { ...listed, tokenAtoms: 40_001n * 100_000_000n };
    const built = buildCurveSellV3({ ticker: "COVE", deploymentTxid: id,
      state, amountTokens: 40_000n, scripts, vaultInput,
      sellerTokenInputs: [sellerInput], tokenChangeSats: 330 });
    expect(markerJson(built.outputs[0]!.scriptHex)).toBe(
      '{"p":"crc-20","op":"transfer","tick":"COVE","amt":"4000000000000"}');
    expect(built.outputs[1]?.scriptHex).toBe(vault);
    expect(built.outputs[2]?.scriptHex).toBe(seller);
    expect(built.requiredInputs).toEqual([vaultInput, sellerInput]);
  });

  it("places the seller payment before the transfer marker and locks the listed outpoint", () => {
    const built = buildCoveV3MarketFill({ ticker: "COVE", deploymentTxid: id,
      listedInput: listed, buyerScriptHex: buyer, recipientSats: 330,
      sellerNetPriceSats: 10_000, protocolScriptHex: protocol,
      protocolFeeSats: 1_000, buyerChangeSats: 1_000 });
    expect(built.outputs[0]).toEqual({ valueSats: 10_670, scriptHex: seller });
    expect(markerJson(built.outputs[1]!.scriptHex)).toBe('{"p":"crc-20","op":"transfer","tick":"COVE","amt":"1000"}');
    expect(built.outputs[2]).toEqual({ valueSats: 330, scriptHex: buyer });
    expect(built.outputs[3]).toEqual({ valueSats: 1_000, scriptHex: protocol });
    expect(built.outputs[4]).toEqual({ valueSats: 1_000, scriptHex: buyer });
    expect(parseCrc20Transaction(built.outputs)).toMatchObject({ status: "valid", envelope: { recipientVout: 2 } });
    const funding: CoveTokenInput = { txid: "bb".repeat(32), vout: 0, valueSats: 13_330,
      scriptHex: buyer, tokenAtoms: 0n };
    const psbt = buildUnsignedPsbt(built, [listed, funding], 1_000);
    expect(psbt.txInputs[0]?.hash.toString("hex")).toBe(listed.txid);
    expect(psbt.data.inputs[0]?.sighashType).toBe(1);
    expect(() => buildUnsignedPsbt(built, [funding, listed], 1_000)).toThrow(/token input|order/i);
  });
});
