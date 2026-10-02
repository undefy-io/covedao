import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import * as core from "@crclaunch/crc20-protocol";
import * as bitcoin from "bitcoinjs-lib";
import * as adapters from "./index.js";
import type { Offer, Plan } from "@crclaunch/crc20-protocol";
const root = new URL(
  "../../../artifacts/crc-core-integration/wallet-capabilities/",
  import.meta.url,
);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
function fixture(purpose: string) {
  const saved = read(`xverse-buyer-${purpose}-plan.json`);
  const plan = core.decodeProtocolDto<Plan>(saved.plan);
  const connection =
    purpose === "nested"
      ? read("xverse-nested-connect.json").value.result
      : read("xverse-real-connect.json").connect.value.result;
  const account = connection.addresses.find(
    (a: { purpose: string }) => a.purpose === (purpose === "nested" ? "payment" : purpose),
  );
  return { plan, account, response: read(`xverse-buyer-${purpose}-response.json`) };
}
test.each(["payment", "ordinals", "nested"])(
  "external %s ALL PSBT matches actual wallet request and completes core plan",
  (purpose) => {
    const { plan, account, response } = fixture(purpose);
    const prepared = adapters.preparePlanSigning(plan, {
      network: "signet",
      walletInputs: [{ index: 1, ...account }],
    });
    const actual = read(`xverse-buyer-${purpose}-request.json`);
    expect(prepared.params).toEqual(actual.params);
    const final = adapters.completePlanSigning(prepared, response.value.result.psbt);
    expect(final.rawHex).toBe(response.rawTransaction);
    core.validateFinalTransaction(plan, final);
  },
);
test.each(["payment", "ordinals"])(
  "external %s offer attaches actual BIP322 and 0x83 signatures",
  (purpose) => {
    const offer = core.decodeProtocolDto<Offer>(read(`xverse-${purpose}-offer.json`).offer);
    const account = read("xverse-real-connect.json").connect.value.result.addresses.find(
      (a: { purpose: string }) => a.purpose === purpose,
    );
    const prepared = adapters.prepareOfferSigning(offer, account);
    expect(prepared.params).toEqual(read(`xverse-seller-${purpose}-request.json`).params);
    const message = read(`xverse-message-${purpose}-response.json`).value.result.signature;
    const signed = read(`xverse-seller-${purpose}-response.json`).value.result.psbt;
    const attached = adapters.completeOfferSigning(prepared, message, signed);
    expect(attached).toEqual(offer);
  },
);
test("reject changed wallet key/script before preparing signing", () => {
  const { plan, account } = fixture("payment");
  expect(() =>
    adapters.preparePlanSigning(plan, {
      network: "signet",
      walletInputs: [{ index: 1, ...account, publicKey: "02" + "11".repeat(32) }],
    }),
  ).toThrow();
});
test("reject response output/prevout tampering and removed finalized seller witness", () => {
  const { plan, account, response } = fixture("payment");
  const prepared = adapters.preparePlanSigning(plan, {
    network: "signet",
    walletInputs: [{ index: 1, ...account }],
  });
  const changed = bitcoin.Psbt.fromBase64(response.value.result.psbt);
  changed.data.inputs[1]!.witnessUtxo!.value--;
  expect(() => adapters.completePlanSigning(prepared, changed.toBase64())).toThrow();
  const removed = bitcoin.Psbt.fromBase64(response.value.result.psbt);
  delete removed.data.inputs[0]!.finalScriptWitness;
  expect(() => adapters.completePlanSigning(prepared, removed.toBase64())).toThrow();
});
test("fresh network mismatch prevents signing; actual cancellation is classified", async () => {
  const { plan, account } = fixture("payment");
  const prepared = adapters.preparePlanSigning(plan, {
    network: "signet",
    walletInputs: [{ index: 1, ...account }],
  });
  const request = vi.fn().mockResolvedValue(read("xverse-network-regtest.json"));
  await expect(adapters.requestWalletSigning({ request }, prepared)).rejects.toThrow(/network/i);
  expect(request.mock.calls.map((c) => c[0])).toEqual(["wallet_getNetwork"]);
  request
    .mockReset()
    .mockResolvedValueOnce(read("xverse-network-signet.json"))
    .mockResolvedValueOnce(read("xverse-buyer-payment-cancel.json").value);
  await expect(adapters.requestWalletSigning({ request }, prepared)).rejects.toMatchObject({
    code: "REJECTED",
  });
  expect(request.mock.calls.map((c) => c[0])).toEqual(["wallet_getNetwork", "signPsbt"]);
});
test("unsupported fresh wallet network keeps typed NETWORK error", async () => {
  const request = vi.fn().mockResolvedValue({ result: { bitcoin: { name: "Testnet4" } } });
  await expect(adapters.assertWalletNetwork({ request }, "signet")).rejects.toMatchObject({
    code: "NETWORK",
  });
  expect(request).toHaveBeenCalledTimes(1);
});
test("actual nested wallet signs core mint plan preserving Guardian execution; tampered witness refuses before prompt", () => {
  const fixture = core.decodeProtocolDto<any>(read("xverse-core-mint-request.json"));
  const response = read("xverse-core-mint-response.json");
  const prepared = adapters.preparePlanSigning(fixture.plan, fixture.options);
  expect(prepared.params).toEqual(fixture.prepared.params);
  expect(adapters.completePlanSigning(prepared, response.value.result.psbt).rawHex).toBe(
    response.rawTransaction,
  );
  const changed = structuredClone(fixture.options);
  changed.finalizedWitnesses[0][1] = "42".repeat(32);
  expect(() => adapters.preparePlanSigning(fixture.plan, changed)).toThrow();
});
test("network change between message and PSBT prompts stops offer signing", async () => {
  const offer = core.decodeProtocolDto<Offer>(read("xverse-payment-offer.json").offer);
  const account = read("xverse-real-connect.json").connect.value.result.addresses.find(
    (a: { purpose: string }) => a.purpose === "payment",
  );
  const prepared = adapters.prepareOfferSigning(offer, account);
  const request = vi
    .fn()
    .mockResolvedValueOnce(read("xverse-network-signet.json"))
    .mockResolvedValueOnce(read("xverse-message-payment-response.json").value)
    .mockResolvedValueOnce(read("xverse-network-regtest.json"));
  await expect(adapters.requestOfferSigning({ request }, prepared)).rejects.toMatchObject({
    code: "NETWORK",
  });
  expect(request.mock.calls.map((c) => c[0])).toEqual([
    "wallet_getNetwork",
    "signMessage",
    "wallet_getNetwork",
  ]);
});
