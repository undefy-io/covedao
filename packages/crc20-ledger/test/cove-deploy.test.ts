import * as bitcoin from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { applyRegisteredCoveDeploy, validateCoveOperation } from "../src/cove.js";
import { createLedger, type LedgerTransaction } from "../src/index.js";

const txid = (byte: string) => byte.repeat(64);
const script = (byte: string) => `5120${byte.repeat(64)}`;
const registration = {
  network: "signet" as const,
  txid: txid("a"),
  vaultScriptHex: script("1"),
  creatorScriptHex: script("2"),
  protocolScriptHex: script("3"),
  vaultAnchorSats: 330,
};
function marker(payload: object) {
  return {
    valueSats: 0,
    scriptHex: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify(payload))]).toString("hex"),
  };
}
function deployment(overrides: Partial<LedgerTransaction> = {}): LedgerTransaction {
  return {
    network: "signet",
    txid: registration.txid,
    height: 100,
    index: 2,
    outputs: [
      marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" }),
      { valueSats: 330, scriptHex: registration.vaultScriptHex },
      { valueSats: 1_000, scriptHex: registration.creatorScriptHex },
      { valueSats: 7_000, scriptHex: registration.protocolScriptHex },
    ],
    ...overrides,
  };
}

describe("registered Cove deployments", () => {
  it("ignores LEAF and unregistered lookalike deployments", () => {
    const state = createLedger();
    const leaf = deployment({ txid: txid("b"), outputs: [marker({ p: "crc-20", op: "deploy", tick: "LEAF" })] });
    expect(applyRegisteredCoveDeploy(state, leaf, [registration])).toMatchObject({ status: "ignored", state });
    expect(applyRegisteredCoveDeploy(state, deployment({ txid: txid("b") }), [registration])).toMatchObject({ status: "ignored", state });
  });

  it("registers only the matching validated deployment", () => {
    const result = applyRegisteredCoveDeploy(createLedger(), deployment(), [registration]);
    expect(result.status).toBe("applied");
    expect(result.state.assets[`signet:${registration.txid}`]).toEqual({ ticker: "COVE", supplyAtoms: "0" });
  });

  it("rejects forged version, cap, fees, and beneficiary scripts without mutation", () => {
    const state = createLedger();
    const original = deployment();
    const cases = [
      { ...original, outputs: [marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000000", cv: "other" }), ...original.outputs.slice(1)] },
      { ...original, outputs: [marker({ p: "crc-20", op: "deploy", tick: "COVE", type: "bonding", max: "2100000000000001", cv: "cove-curve-v1" }), ...original.outputs.slice(1)] },
      { ...original, outputs: original.outputs.map((output, index) => index === 3 ? { ...output, valueSats: 330 } : output) },
      { ...original, outputs: original.outputs.map((output, index) => index === 3 ? { ...output, scriptHex: script("4") } : output) },
    ];
    for (const candidate of cases) {
      const result = applyRegisteredCoveDeploy(state, candidate, [registration]);
      expect(result.status).toBe("invalid");
      expect(result.state).toBe(state);
    }
  });

  it("rejects a vault anchor below the registered script dust threshold", () => {
    const legacyScript = bitcoin.payments.p2pkh({ hash: Buffer.alloc(20, 5) }).output!.toString("hex");
    const legacy = { ...registration, vaultScriptHex: legacyScript };
    const candidate = deployment({ outputs: deployment().outputs.map((output, index) => index === 1 ? { ...output, scriptHex: legacyScript } : output) });
    expect(applyRegisteredCoveDeploy(createLedger(), candidate, [legacy]).status).toBe("invalid");
  });

  it("keeps duplicate ticker deployments separate by network and txid", () => {
    const second = { ...registration, txid: txid("b"), vaultScriptHex: script("4") };
    const firstResult = applyRegisteredCoveDeploy(createLedger(), deployment(), [registration, second]);
    const secondTx = deployment({ txid: second.txid, index: 3, outputs: deployment().outputs.map((output, index) => index === 1 ? { ...output, scriptHex: second.vaultScriptHex } : output) });
    const secondResult = applyRegisteredCoveDeploy(firstResult.state, secondTx, [registration, second]);
    expect(secondResult.status).toBe("applied");
    expect(Object.keys(secondResult.state.assets).sort()).toEqual([`signet:${registration.txid}`, `signet:${second.txid}`].sort());
  });
});

describe("Cove post-deploy marker format", () => {
  const asset = { txid: registration.txid, ticker: "COVE" };
  const recipient = { valueSats: 330, scriptHex: script("4") };
  const payload = { p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000", id: registration.txid };
  it("requires the registered deployment id and exact marker fields", () => {
    expect(validateCoveOperation([marker(payload), recipient], asset)).toMatchObject({ status: "valid", kind: "transfer", amountAtoms: 100000000000n });
    for (const changed of [
      { ...payload, id: txid("b") },
      { ...payload, id: undefined },
      { ...payload, amt: "0100000000000" },
      { ...payload, extra: "ignored" },
      { ...payload, tick: "OTHER" },
      { ...payload, amt: "1".repeat(300) },
    ]) {
      expect(validateCoveOperation([marker(changed), recipient], asset).status).toBe("invalid");
    }
  });
  it("requires a single zero-value marker at vout 0 and a recipient at vout 1", () => {
    expect(validateCoveOperation([recipient, marker(payload), recipient], asset).status).toBe("invalid");
    expect(validateCoveOperation([marker(payload), marker(payload), recipient], asset).status).toBe("invalid");
    expect(validateCoveOperation([marker(payload)], asset).status).toBe("invalid");
    expect(validateCoveOperation([marker(payload), { ...recipient, valueSats: 1 }], asset).status).toBe("invalid");
  });
  it("accepts an exact Cove mint amount field while rejecting Garden amountless mint", () => {
    expect(validateCoveOperation([marker({ ...payload, op: "mint" }), recipient], asset)).toMatchObject({ status: "valid", kind: "mint", amountAtoms: 100000000000n });
    expect(validateCoveOperation([marker({ p: "crc-20", op: "mint", tick: "COVE", id: registration.txid }), recipient], asset).status).toBe("invalid");
  });
});
