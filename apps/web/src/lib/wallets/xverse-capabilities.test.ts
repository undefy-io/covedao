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
  const request = vi.fn(async (method: string) => method === "wallet_getNetwork" ? { result: { bitcoin: { name: "Signet" } } } : result);
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
    expect(request).toHaveBeenCalledTimes(2);
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
  expect(request).toHaveBeenCalledTimes(2);
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
    expect(request).toHaveBeenCalledTimes(2);
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
  provider({ result: { network: { bitcoin: { name: "Mainnet" } }, addresses: [] } });
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

test("actual wallet network mismatch refuses signPsbt and BIP322 before signing requests", async () => {
  const request = vi.fn(async (_method: string) => ({ result: { bitcoin: { name: "Mainnet" } } }));
  vi.stubGlobal("window", { XverseProviders: { BitcoinProvider: { request } } });
  await expect(adapterFor("xverse").signPsbt("signet", { psbtBase64: fixture(1).toBase64(), inputsByAddress: [{ address: "selected-address", indexes: [1] }] })).rejects.toMatchObject({ code: "WRONG_NETWORK" });
  await expect(adapterFor("xverse").signMessage("signet", "selected-address", "terms")).rejects.toMatchObject({ code: "WRONG_NETWORK" });
  expect(request.mock.calls.map(([method]) => method)).toEqual(["wallet_getNetwork", "wallet_getNetwork"]);
});

for (const operation of ["psbt", "message"] as const) {
  test(`disconnect during Xverse network observation prevents the ${operation} signing request`, async () => {
    let release!: () => void, observing!: () => void, connected = true;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { observing = resolve; });
    const request = vi.fn(async (method: string) => {
      if (method === "wallet_getNetwork") { observing(); await held; return { result: { bitcoin: { name: "Signet" } } }; }
      return { result: { psbt: fixture(1).toBase64(), signature: "unused" } };
    });
    vi.stubGlobal("window", { XverseProviders: { BitcoinProvider: { request } } });
    const assertCurrent = () => { if (!connected) throw new Error("Wallet disconnected"); };
    const result = operation === "psbt"
      ? adapterFor("xverse").signPsbt("signet", { psbtBase64: fixture(1).toBase64(), inputsByAddress: [{ address: "selected-address", indexes: [1] }], assertCurrent })
      : adapterFor("xverse").signMessage("signet", "selected-address", "terms", assertCurrent);
    const rejected = expect(result).rejects.toThrow(/disconnected/i);
    await started; connected = false; release(); await rejected;
    expect(request.mock.calls.map(([method]) => method)).toEqual(["wallet_getNetwork"]);
  });
}

test("Xverse connects through wallet_connect to grant network-read permission and retain purpose", async () => {
  const { readFileSync } = await import("node:fs");
  const connected = JSON.parse(readFileSync(new URL("../../../../../artifacts/crc-core-integration/wallet-capabilities/xverse-real-connect.json", import.meta.url), "utf8")).connect.value;
  const request = vi.fn(async (method: string) => method === "wallet_connect" ? connected : { error: { code: -32002, message: "Access denied." } });
  vi.stubGlobal("window", { XverseProviders: { BitcoinProvider: { request } } });
  const result = await adapterFor("xverse").connect("signet");
  expect(request).toHaveBeenCalledWith("wallet_connect", { addresses: ["payment", "ordinals"], network: "Signet", message: "Connect to covs.trade" });
  expect(result.payments.address).toBe(connected.result.addresses[0].address);
  expect(result.ordinals.address).toBe(connected.result.addresses[1].address);
  expect(request).toHaveBeenCalledTimes(1);
});

for (const operation of ["psbt", "message"] as const) {
  test(`network-read access denial is not reported as cancellation and prevents ${operation} prompt`, async () => {
    const request = vi.fn(async (_method: string) => ({ error: { code: -32002, message: "Access denied." } }));
    vi.stubGlobal("window", { XverseProviders: { BitcoinProvider: { request } } });
    const action = operation === "psbt" ? adapterFor("xverse").signPsbt("signet", { psbtBase64: fixture(1).toBase64(), inputsByAddress: [{ address: "selected-address", indexes: [1] }] }) : adapterFor("xverse").signMessage("signet", "selected-address", "terms");
    await expect(action).rejects.toMatchObject({ code: "FAILED" });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["wallet_getNetwork"]);
  });
}

test("modern connection grants read permission before network check and the single PSBT request", async () => {
  const { readFileSync } = await import("node:fs");
  const connected = JSON.parse(readFileSync(new URL("../../../../../artifacts/crc-core-integration/wallet-capabilities/xverse-real-connect.json", import.meta.url), "utf8")).connect.value;
  let permitted = false;
  const encoded = fixture(1).toBase64();
  const request = vi.fn(async (method: string) => {
    if (method === "wallet_connect") { permitted = true; return connected; }
    if (!permitted) return { error: { code: -32002, message: "Access denied." } };
    if (method === "wallet_getNetwork") return { result: { bitcoin: { name: "Signet" } } };
    return { result: { psbt: encoded } };
  });
  vi.stubGlobal("window", { XverseProviders: { BitcoinProvider: { request } } });
  await adapterFor("xverse").connect("signet");
  expect(await adapterFor("xverse").signPsbt("signet", { psbtBase64: encoded, inputsByAddress: [{ address: "selected-address", indexes: [1] }] })).toBe(encoded);
  expect(request.mock.calls.map(([method]) => method)).toEqual(["wallet_connect", "wallet_getNetwork", "signPsbt"]);
});

for (const error of [Object.assign(new Error("Access denied."), { code: -32002 }), { code: -32002, message: "User permissions are missing" }]) {
  test(`thrown permission failure ${String(error)} is not a user cancellation`, async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "wallet_getNetwork") return { result: { bitcoin: { name: "Signet" } } };
      throw error;
    });
    vi.stubGlobal("window", { XverseProviders: { BitcoinProvider: { request } } });
    await expect(adapterFor("xverse").signPsbt("signet", { psbtBase64: fixture(1).toBase64(), inputsByAddress: [{ address: "selected-address", indexes: [1] }] })).rejects.toMatchObject({ code: "FAILED", message: expect.stringMatching(/permission/i) });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["wallet_getNetwork", "signPsbt"]);
  });
}

test("explicit user rejection of a permission prompt stays a rejection without retry", async () => {
  const request = provider({ error: { code: 4001, message: "User rejected permission request" } });
  await expect(adapterFor("xverse").signMessage("signet", "selected-address", "terms")).rejects.toMatchObject({ code: "REJECTED" });
  expect(request).toHaveBeenCalledTimes(2);
});
