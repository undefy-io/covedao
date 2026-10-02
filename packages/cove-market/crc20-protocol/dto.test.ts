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
