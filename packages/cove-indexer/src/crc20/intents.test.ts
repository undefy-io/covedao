import * as bitcoin from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { prepareCrcLaunchIntent } from "./intents.js";

const script = (byte: string) => `5120${byte.repeat(64)}`;
const trusted = {
  launchSaltHex: "ab".repeat(32), vaultScriptHex: script("1"), creatorScriptHex: script("2"),
  protocolScriptHex: script("3"), vaultAnchorSats: 330,
};

function signedDeploy(change = 1670, feeScript = trusted.protocolScriptHex) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.from("44".repeat(32), "hex"), 0);
  tx.ins[0]!.witness = [Buffer.from("55".repeat(64), "hex")];
  const marker = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" }))]);
  tx.addOutput(marker, 0);
  tx.addOutput(Buffer.from(trusted.vaultScriptHex, "hex"), 330);
  tx.addOutput(Buffer.from(trusted.creatorScriptHex, "hex"), 1000);
  tx.addOutput(Buffer.from(feeScript, "hex"), 7000);
  tx.addOutput(Buffer.from(script("4"), "hex"), change);
  return tx;
}

describe("authorized Cove launch intent", () => {
  it("derives identity and scripts from the final raw deploy and keeps its salt", () => {
    const tx = signedDeploy();
    const intent = prepareCrcLaunchIntent("signet", tx.toHex(), trusted);
    expect(intent).toMatchObject({ network: "signet", txid: tx.getId(), launchSaltHex: trusted.launchSaltHex, vaultScriptHex: trusted.vaultScriptHex, protocolScriptHex: trusted.protocolScriptHex, vaultAnchorSats: 330 });
  });

  it("rejects changed protocol fees/scripts and unsigned inputs", () => {
    expect(() => prepareCrcLaunchIntent("signet", signedDeploy(1670, script("5")).toHex(), trusted)).toThrow();
    const unsigned = signedDeploy();
    unsigned.ins[0]!.witness = [];
    expect(() => prepareCrcLaunchIntent("signet", unsigned.toHex(), trusted)).toThrow();
  });

  it("rejects invalid salt or untrusted vault script", () => {
    const raw = signedDeploy().toHex();
    expect(() => prepareCrcLaunchIntent("signet", raw, { ...trusted, launchSaltHex: "aa" })).toThrow();
    expect(() => prepareCrcLaunchIntent("signet", raw, { ...trusted, vaultScriptHex: script("6") })).toThrow();
  });
});
