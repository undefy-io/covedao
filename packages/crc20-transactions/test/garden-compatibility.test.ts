import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Transaction } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { parseCrc20Transaction } from "@crclaunch/crc20-base";
import { createCurveState } from "@crclaunch/crc20-curve";
import { buildCoveV3MarketFill, buildCurveBuyV3, buildCurveDeployV3 } from "../src/index.js";

type Fixture = { kind: string; txid: string; hex: string };
type Output = { valueSats: number; scriptHex: string };

const fixtures = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../../crc20-base/test/fixtures/leaf-mainnet.json", import.meta.url,
)), "utf8")) as Fixture[];

function observed(txid: string): Output[] {
  const fixture = fixtures.find((item) => item.txid === txid);
  if (!fixture) throw new Error(`missing Garden fixture ${txid}`);
  const tx = Transaction.fromHex(fixture.hex);
  expect(tx.getId()).toBe(txid);
  return tx.outs.map((out) => ({ valueSats: out.value, scriptHex: out.script.toString("hex") }));
}

function shape(outputs: readonly Output[]) {
  const parsed = parseCrc20Transaction(outputs);
  expect(parsed.status).toBe("valid");
  if (parsed.status !== "valid") throw new Error("invalid CRC transaction");
  const { envelope } = parsed;
  const recipientVout = envelope.kind === "deploy" ? undefined :
    envelope.kind === "mint" ? envelope.markerVout + 1 : envelope.recipientVout;
  return {
    operation: envelope.kind,
    fields: Object.keys(envelope.payload),
    markerVout: envelope.markerVout,
    markerValue: outputs[envelope.markerVout]?.valueSats,
    recipientVout,
    recipientSpendable: recipientVout === undefined ? undefined :
      (outputs[recipientVout]?.valueSats ?? 0) > 0 &&
      !outputs[recipientVout]?.scriptHex.startsWith("6a"),
    sellerPayoutBeforeMarker: envelope.markerVout === 1 &&
      (outputs[0]?.valueSats ?? 0) > 0 && !outputs[0]?.scriptHex.startsWith("6a"),
  };
}

const id = "99".repeat(32);
const seller = `0014${"11".repeat(20)}`;
const buyer = `5120${"22".repeat(32)}`;
const vault = `5120${"33".repeat(32)}`;
const protocol = `5120${"44".repeat(32)}`;
const creator = `5120${"55".repeat(32)}`;

describe("Cove transactions against captured Garden mainnet transactions", () => {
  it("matches the Garden mint envelope, marker position, and recipient adjacency", () => {
    const state = createCurveState(`${"aa".repeat(32)}:1`, 330n);
    const built = buildCurveBuyV3({
      ticker: "COVE", deploymentTxid: id, state, amountTokens: 1_000n,
      scripts: { seller, buyer, vault, protocol, creator }, recipientSats: 330,
      vaultInput: { txid: "aa".repeat(32), vout: 1, valueSats: 330,
        scriptHex: vault, tokenAtoms: 0n },
    });
    const garden = shape(observed("17c4c6fa3a877aa42c142f4836c3cb6b10d4e588ff2150df842e2e3e3e89bde4"));
    expect(shape(built.outputs)).toEqual(garden);
  });

  it("matches the Garden sale envelope and seller-payment/marker/buyer ordering", () => {
    const built = buildCoveV3MarketFill({
      ticker: "COVE", deploymentTxid: id,
      listedInput: { txid: "aa".repeat(32), vout: 0, valueSats: 670,
        scriptHex: seller, tokenAtoms: 6_800_000_000_000n, tokenDeploymentTxid: id },
      buyerScriptHex: buyer, recipientSats: 1_000, sellerNetPriceSats: 433_830,
      protocolScriptHex: protocol, protocolFeeSats: 1_000,
    });
    const garden = shape(observed("532f22d0edcd848d28b81ddb6b089402860d01fda2ec1fdb9701ea13bb0a2dcd"));
    expect(shape(built.outputs)).toEqual(garden);
    expect(built.outputs[0]?.valueSats).toBe(434_500);
    expect(built.outputs[2]?.valueSats).toBe(1_000);
  });

  it("records the deployment fields that remain specific to each launchpad", () => {
    const built = buildCurveDeployV3({ ticker: "COVE", maxAtoms: "2100000000000000",
      scripts: { vault, creator, protocol }, vaultAnchorSats: 330 });
    const garden = shape(observed("546cc042d0f396a0d8ad67b6987d9d5c09619e6962738347ca1611a1d1841b67"));
    const cove = shape(built.outputs);
    expect(garden.fields).toEqual(["p", "op", "tick", "type", "max", "lim", "leaf", "ordi", "btc"]);
    expect(cove.fields).toEqual(["p", "op", "tick", "type", "max", "cv"]);
    expect(cove.fields.slice(0, 5)).toEqual(garden.fields.slice(0, 5));
  });
});
