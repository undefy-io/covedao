import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import * as adapter from "./index.js";
const root = new URL(
  "../../../artifacts/crc-core-integration/wallet-capabilities/",
  import.meta.url,
);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
function fixture() {
  const { state, plan } = core.decodeProtocolDto<{ state: core.Asset; plan: core.Plan }>(
    read("xverse-core-mint-request.json"),
  );
  const ledger = core.emptyLedger(state.config);
  ledger.assets[state.deployTxid] = state;
  const account = read("xverse-nested-connect.json").value.result.addresses.find(
    (a: { purpose: string }) => a.purpose === "payment",
  );
  const response = bitcoin.Psbt.fromBase64(
    read("xverse-core-mint-response.json").value.result.psbt,
  );
  delete response.data.inputs[0]!.finalScriptWitness;
  return { ledger, plan, account, response };
}
test("wallet-first Guardian preparation leaves only custody unsigned and verifies actual Xverse response", () => {
  const f = fixture();
  const prepared = adapter.prepareGuardianPlanSigning(f.plan, f.ledger, {
    network: "signet",
    walletInputs: [{ ...f.account, index: 1 }],
  });
  const psbt = bitcoin.Psbt.fromBase64(prepared.params.psbt);
  expect(psbt.data.inputs[0]!.finalScriptWitness).toBeUndefined();
  expect(prepared.params.signInputs).toEqual({ [f.account.address]: [1] });
  const completed = adapter.completeGuardianWalletSigning(
    prepared,
    f.response.toBase64(),
    f.ledger,
  );
  expect(completed.transition.kind).toBe("mint");
  expect(core.parseRawTransaction(completed.transaction.rawHex).inputs[0]!.witness).toEqual([]);
  expect(
    bitcoin.Psbt.fromBase64(completed.psbtBase64).data.inputs[1]!.finalScriptWitness,
  ).toBeDefined();
  expect(() => adapter.completePlanSigning(prepared, f.response.toBase64(), f.ledger)).toThrow();
});
test("Guardian preparation never skips another wallet, signs custody as wallet, or accepts a stale vault", () => {
  const f = fixture();
  const options = { network: "signet", walletInputs: [{ ...f.account, index: 1 }] };
  expect(() =>
    adapter.prepareGuardianPlanSigning(f.plan, f.ledger, {
      ...options,
      walletInputs: [{ ...f.account, index: 0 }],
    }),
  ).toThrow();
  expect(() =>
    adapter.prepareGuardianPlanSigning(f.plan, core.emptyLedger(f.ledger.config), options),
  ).toThrow();
  const prepared = adapter.prepareGuardianPlanSigning(f.plan, f.ledger, options);
  delete f.response.data.inputs[1]!.partialSig;
  delete f.response.data.inputs[1]!.finalScriptWitness;
  expect(() =>
    adapter.completeGuardianWalletSigning(prepared, f.response.toBase64(), f.ledger),
  ).toThrow();
});
test("server serializes the core plan and exact nested metadata without manufacturing signatures", () => {
  const f = fixture();
  const psbt = adapter.createPlanPsbt(f.plan, "signet", { publicKeys: { 1: f.account.publicKey } });
  expect(psbt.txInputs).toHaveLength(f.plan.inputs.length);
  expect(psbt.txOutputs.map((output) => BigInt(output.value))).toEqual(
    f.plan.outputs.map((output) => output.sats),
  );
  expect(psbt.data.inputs[0]!.finalScriptWitness).toBeUndefined();
  expect(psbt.data.inputs[1]!.redeemScript!.toString("hex")).toBe(
    f.plan.inputs[1]!.redeemScriptHex,
  );
  expect(() =>
    adapter.createPlanPsbt(f.plan, "signet", { publicKeys: { 1: "02" + "11".repeat(32) } }),
  ).toThrow();
});
test("server completes wallet-first signatures against the exact stored plan and current ledger", () => {
  const f = fixture();
  const original = adapter
    .createPlanPsbt(f.plan, "signet", { publicKeys: { 1: f.account.publicKey } })
    .toBase64();
  expect(
    adapter.completeServerWalletSigning(
      f.plan,
      "signet",
      original,
      f.response.toBase64(),
      f.ledger,
      true,
    ).transition!.kind,
  ).toBe("mint");
  const changed = bitcoin.Psbt.fromBase64(f.response.toBase64());
  changed.data.inputs[1]!.witnessUtxo!.value--;
  expect(() =>
    adapter.completeServerWalletSigning(
      f.plan,
      "signet",
      original,
      changed.toBase64(),
      f.ledger,
      true,
    ),
  ).toThrow();
});

test("browser-finalized nested wallet signatures survive the subsequent server verification", () => {
  const f = fixture();
  const prepared = adapter.prepareGuardianPlanSigning(f.plan, f.ledger, {
    network: "signet", walletInputs: [{ ...f.account, index: 1 }],
  });
  const completed = adapter.completeBrowserWalletSigning(prepared, f.response.toBase64(), f.ledger);
  const original = adapter.createPlanPsbt(f.plan, "signet", { publicKeys: { 1: f.account.publicKey } }).toBase64();
  expect(adapter.completeServerWalletSigning(f.plan, "signet", original, completed.psbtBase64, f.ledger, true).transition!.kind).toBe("mint");
  const changed = bitcoin.Psbt.fromBase64(completed.psbtBase64);
  changed.data.inputs[1]!.finalScriptSig = Buffer.from("00", "hex");
  expect(() => adapter.completeServerWalletSigning(f.plan, "signet", original, changed.toBase64(), f.ledger, true)).toThrow();
});
