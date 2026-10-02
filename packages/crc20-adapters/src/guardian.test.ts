import { readFileSync } from "node:fs";
import { test, expect, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import * as core from "@crclaunch/crc20-protocol";
import * as adapter from "./index.js";
const root = new URL(
  "../../../artifacts/crc-core-integration/wallet-capabilities/",
  import.meta.url,
);
const request = core.decodeProtocolDto<{ state: core.Asset; plan: core.Plan }>(
  JSON.parse(readFileSync(new URL("xverse-core-mint-request.json", root), "utf8")),
);
const response = JSON.parse(readFileSync(new URL("xverse-core-mint-response.json", root), "utf8"));
function fixture() {
  const ledger = core.emptyLedger(request.state.config);
  ledger.assets[request.state.deployTxid] = structuredClone(request.state);
  const psbt = bitcoin.Psbt.fromBase64(response.value.result.psbt);
  delete psbt.data.inputs[0]!.finalScriptWitness;
  if (!psbt.data.inputs[1]!.finalScriptWitness) psbt.finalizeInput(1);
  const sign = vi.fn(async ({ sighash }: { sighash: Uint8Array }) =>
    ecc.signSchnorr(sighash, Buffer.alloc(32, 1)),
  );
  const backend = {
    xOnlyPubkey: async () =>
      Buffer.from(request.state.config.guardianCustody!.guardianPublicKeyHex, "hex"),
    signTaprootScriptPath: sign,
  };
  return { ledger, psbt, backend, sign };
}
test("Guardian adapter signs only core-validated custody, preserves finalized wallet and verifies complete raw", async () => {
  const f = fixture();
  const wallet = Buffer.from(f.psbt.data.inputs[1]!.finalScriptWitness!);
  const result = await adapter.signGuardianPsbt(f.psbt.toBase64(), f.ledger, f.backend);
  expect(f.sign).toHaveBeenCalledTimes(1);
  const signed = bitcoin.Psbt.fromBase64(result.psbtBase64);
  expect(signed.data.inputs[1]!.finalScriptWitness).toEqual(wallet);
  core.validateFinalTransaction(result.transition.plan, result.transaction, f.ledger);
  expect(result.transition.kind).toBe("mint");
});
test("Guardian adapter refuses wallet or economic tampering before custody; bad custody signature is rejected", async () => {
  const f = fixture();
  f.psbt.data.inputs[1]!.witnessUtxo!.value++;
  await expect(adapter.signGuardianPsbt(f.psbt.toBase64(), f.ledger, f.backend)).rejects.toThrow();
  expect(f.sign).not.toHaveBeenCalled();
  const bad = fixture();
  bad.sign.mockResolvedValue(Buffer.alloc(64));
  await expect(
    adapter.signGuardianPsbt(bad.psbt.toBase64(), bad.ledger, bad.backend),
  ).rejects.toThrow();
});
