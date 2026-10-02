import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import * as core from "./index.js";
import type { Offer, Plan, Input } from "./types.js";

const root = new URL(
  "../../../artifacts/crc-core-integration/wallet-capabilities/",
  import.meta.url,
);
bitcoin.initEccLib(ecc);
function read(name: string) {
  return JSON.parse(readFileSync(new URL(name, root), "utf8"), (key, value) =>
    typeof value === "string" && /^(sats|atoms|priceSats|.*Atoms|.*Sats)$/.test(key)
      ? BigInt(value)
      : value,
  );
}
test.each(["payment", "ordinals"])(
  "actual Xverse %s BIP322 and seller 0x83 evidence verifies",
  (purpose) => {
    const offer = read(`xverse-${purpose}-offer.json`).offer as Offer;
    const request = read(`xverse-message-${purpose}-request.json`);
    const response = read(`xverse-message-${purpose}-response.json`);
    expect(request.params.message).toBe(core.offerMessage(offer));
    expect(Buffer.from(response.value.result.signature, "base64").toString("hex")).toBe(
      offer.signatureHex,
    );
    core.verifyOffer(offer);
    expect(() => core.verifyOffer({ ...offer, priceSats: offer.priceSats + 1n })).toThrow();
  },
);
test.each(["payment", "ordinals", "nested"])(
  "actual Xverse %s buyer signs exact plan and preserves seller",
  (purpose) => {
    const { plan } = read(`xverse-buyer-${purpose}-plan.json`) as { plan: Plan };
    const request = read(`xverse-buyer-${purpose}-request.json`);
    const response = read(`xverse-buyer-${purpose}-response.json`);
    const before = bitcoin.Psbt.fromBase64(request.params.psbt);
    const after = bitcoin.Psbt.fromBase64(response.value.result.psbt);
    expect(after.data.globalMap.unsignedTx.toBuffer()).toEqual(
      before.data.globalMap.unsignedTx.toBuffer(),
    );
    expect(after.data.inputs[0]!.finalScriptWitness).toEqual(
      before.data.inputs[0]!.finalScriptWitness,
    );
    after.finalizeInput(1);
    expect(after.extractTransaction().toHex()).toBe(response.rawTransaction);
    expect(request.params.broadcast).toBe(false);
    expect(Object.values(request.params.signInputs)).toEqual([[1]]);
    core.validateFinalTransaction(plan, { rawHex: response.rawTransaction, prevouts: plan.inputs });
    expect(
      plan.inputs.reduce((sum, p) => sum + BigInt(p.sats), 0n) -
        plan.outputs.reduce((sum, p) => sum + BigInt(p.sats), 0n),
    ).toBe(1000n);
  },
);
test("actual Xverse preserves finalized Guardian script path while signing its own ALL input", () => {
  const request = read("xverse-guardian-request.json");
  const response = read("xverse-guardian-response.json");
  const before = bitcoin.Psbt.fromBase64(request.params.psbt);
  const after = bitcoin.Psbt.fromBase64(response.value.result.psbt);
  expect(after.data.globalMap.unsignedTx.toBuffer()).toEqual(
    before.data.globalMap.unsignedTx.toBuffer(),
  );
  expect(after.data.inputs[0]!.finalScriptWitness).toEqual(
    before.data.inputs[0]!.finalScriptWitness,
  );
  after.finalizeInput(1);
  expect(after.extractTransaction().toHex()).toBe(response.rawTransaction);
  core.verifySignatures(
    core.parseRawTransaction(response.rawTransaction),
    request.prevouts as Input[],
  );
});
test("actual wallet distinguishes Signet from Regtest using metadata", () => {
  expect(read("xverse-network-signet.json").result.bitcoin.name).toBe("Signet");
  expect(read("xverse-network-regtest.json").result.bitcoin.name).toBe("Regtest");
});
