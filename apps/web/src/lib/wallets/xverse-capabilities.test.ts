import { afterEach, expect, test, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { adapterFor } from "./adapters";

// Transport-only evidence. This provider has no keys and cannot sign.
vi.mock("@ordzaar/ordit-sdk/xverse", () => ({
  isInstalled: () => Boolean((globalThis as any).window?.XverseProviders?.BitcoinProvider),
  getAddresses: async () => [
    {
      address: bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 1) }).address!,
      publicKey: "",
      format: "segwit",
    },
  ],
}));
afterEach(() => vi.unstubAllGlobals());
function provider(result: unknown) {
  const request = vi.fn().mockResolvedValue(result);
  vi.stubGlobal("window", { XverseProviders: { BitcoinProvider: { request } } });
  return request;
}
function fixture(sighashType: number) {
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
  psbt.addInput({
    hash: "a".repeat(64),
    index: 0,
    witnessUtxo: { script: Buffer.from(`5120${"b".repeat(64)}`, "hex"), value: 1000 },
    finalScriptWitness: Buffer.from("010151", "hex"),
  });
  psbt.addInput({
    hash: "c".repeat(64),
    index: 1,
    witnessUtxo: { script: Buffer.from(`0014${"d".repeat(40)}`, "hex"), value: 1000 },
    sighashType,
  });
  psbt.addOutput({ script: Buffer.from(`0014${"d".repeat(40)}`, "hex"), value: 1000 });
  return psbt;
}
for (const flag of [0x83, bitcoin.Transaction.SIGHASH_ALL]) {
  test(`mock Xverse transport preserves input flag ${flag} and finalized witness, asks only named wallet input`, async () => {
    const psbt = fixture(flag),
      encoded = psbt.toBase64();
    const request = provider({ result: { psbt: encoded } });
    const returned = await adapterFor("xverse").signPsbt("signet", {
      psbtBase64: encoded,
      inputsByAddress: [{ address: "selected-address", indexes: [1] }],
      sighashType: flag,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("signPsbt", {
      psbt: encoded,
      signInputs: { "selected-address": [1] },
      broadcast: false,
    });
    const parsed = bitcoin.Psbt.fromBase64(returned);
    expect(parsed.data.inputs[1]!.sighashType).toBe(flag);
    expect(parsed.data.inputs[0]!.finalScriptWitness).toEqual(
      psbt.data.inputs[0]!.finalScriptWitness,
    );
  });
}
test("mock bound-message request selects BIP322 and passes exact terms once", async () => {
  const request = provider({ result: { signature: "mock-response-not-a-proof" } });
  const message = '["cove-crc-offer-v1","signet","deployment","outpoint","123456789"]';
  expect(await adapterFor("xverse").signMessage("signet", "selected-address", message)).toBe(
    "mock-response-not-a-proof",
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("signMessage", {
    address: "selected-address",
    message,
    protocol: "BIP322",
  });
});
for (const error of [
  { code: 4001, message: "User rejected" },
  { code: -32000, message: "User cancelled" },
]) {
  test(`mock provider refusal ${error.code} is a cancellation with no retry`, async () => {
    const request = provider({ error });
    await expect(
      adapterFor("xverse").signMessage("signet", "selected-address", "terms"),
    ).rejects.toMatchObject({ code: "REJECTED" });
    expect(request).toHaveBeenCalledTimes(1);
  });
}
test("regtest is rejected before any browser provider prompt", async () => {
  const request = provider({ result: { signature: "unused" } });
  await expect(
    adapterFor("xverse").signMessage("regtest", "selected-address", "terms"),
  ).rejects.toMatchObject({ code: "WRONG_NETWORK" });
  expect(request).not.toHaveBeenCalled();
});
test("mainnet address returned during signet connect is rejected", async () => {
  provider({});
  await expect(adapterFor("xverse").connect("signet")).rejects.toMatchObject({
    code: "WRONG_NETWORK",
  });
});
test("missing provider refuses signing before transport", async () => {
  vi.stubGlobal("window", {});
  await expect(
    adapterFor("xverse").signMessage("signet", "selected-address", "terms"),
  ).rejects.toMatchObject({ code: "NOT_INSTALLED" });
});
