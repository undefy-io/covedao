import { expect, test } from "vitest";
import * as core from "./index.js";
import type { Offer, Plan } from "./types.js";
const script = `0014${"11".repeat(20)}`;
const plan: Plan = {
  inputs: [
    {
      txid: "a".repeat(64),
      vout: 3,
      sats: 20000,
      scriptHex: script,
      atoms: 900719925474099312345n,
    },
  ],
  outputs: [{ sats: 19000n, scriptHex: script, atoms: 900719925474099312345n, role: "recipient" }],
  transactions: [],
  markerJson: '{"p":"crc-20","amt":"900719925474099312345"}',
  markerVout: 1,
  recipientVout: 0,
  changeAtoms: 0n,
  protocolFeeSats: 0n,
  creatorFeeSats: 0n,
  minerFeeSats: 1000n,
};
test("canonical DTO transport round trips large atoms, numeric input sats and untouched marker text", () => {
  const dto = core.encodeProtocolDto(plan);
  expect(dto.inputs[0]!.sats).toBe("20000");
  expect(dto.outputs[0]!.atoms).toBe("900719925474099312345");
  const decoded = core.decodeProtocolDto<Plan>(JSON.parse(JSON.stringify(dto)));
  expect(decoded).toEqual({ ...plan, inputs: [{ ...plan.inputs[0]!, sats: 20000n }] });
  expect(plan.inputs[0]!.sats).toBe(20000);
});
test.each(["00", "01", "-1", "+1", "1e4", " 1", "1.0", 1, null])(
  "reject noncanonical DTO amounts %s",
  (value) => {
    expect(() =>
      core.decodeProtocolDto<Plan>({ ...core.encodeProtocolDto(plan), minerFeeSats: value }),
    ).toThrow();
  },
);
test("refuse unsafe numeric money and unrecognized bigint fields instead of coercing", () => {
  expect(() =>
    core.encodeProtocolDto({
      ...plan,
      inputs: [{ ...plan.inputs[0]!, sats: Number.MAX_SAFE_INTEGER + 1 }],
    }),
  ).toThrow();
  expect(() => core.encodeProtocolDto({ expiryHeight: 1n })).toThrow();
});
test("nested protocol DTOs preserve network identity and signed offer fields", () => {
  const offer = {
    network: "signet",
    priceSats: 1n,
    listedInput: { atoms: 9007199254740993n, sats: 1000n },
    signatureHex: "abc",
    sellerWitnessHex: ["def"],
  } as Offer;
  const value = {
    offers: { ["signet:" + "a".repeat(64)]: offer },
    config: { network: "signet", ticker: "123" },
    history: {},
  };
  expect(
    core.decodeProtocolDto<typeof value>(JSON.parse(JSON.stringify(core.encodeProtocolDto(value)))),
  ).toEqual(value);
});
test("core small sell plans transport signed economic deltas without permitting negative BTC values", () => {
  const config = {
    network: "regtest",
    ticker: "TEST",
    vaultScriptHex: script,
    creatorScriptHex: script,
    protocolScriptHex: script,
  };
  const state = {
    config,
    deployTxid: "a".repeat(64),
    issuedAtoms: 100000000000n,
    inventoryAtoms: 0n,
    burnedAtoms: 0n,
    vault: { txid: "b".repeat(64), vout: 2, sats: 1027n, scriptHex: script },
  };
  const sell = core.buildSell({
    state,
    inputs: [
      {
        txid: "c".repeat(64),
        vout: 1,
        sats: 1000n,
        scriptHex: script,
        atoms: 100000000000n,
        deployTxid: state.deployTxid,
      },
    ],
    funding: [{ txid: "d".repeat(64), vout: 0, sats: 100000n, scriptHex: script }],
    amountAtoms: 100000000000n,
    recipientScriptHex: script,
    minerFeeSats: 1000n,
  });
  expect(core.decodeProtocolDto(core.encodeProtocolDto(sell))).toEqual(sell);
  expect(core.encodeProtocolDto(sell)).toMatchObject({ economicSats: "-973" });
  expect(() => core.decodeProtocolDto({ economicSats: "-0" })).toThrow();
  expect(() => core.decodeProtocolDto({ economicSats: "-01" })).toThrow();
  expect(() => core.decodeProtocolDto({ minerFeeSats: "-973" })).toThrow();
});
