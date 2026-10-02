import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import type { ChainTransaction, Ledger, ValidatedTransition } from "@crclaunch/crc20-protocol";
import { rawWithWitnesses } from "./psbt.js";
export interface GuardianSigningBackend {
  xOnlyPubkey(): Promise<Uint8Array>;
  signTaprootScriptPath(params: { sighash: Buffer; leafTapleafHash: Buffer }): Promise<Uint8Array>;
}
/** Serialize/finalize wallet inputs; protocol authorization stays in the core. */
export function guardianPsbtTransaction(psbt: bitcoin.Psbt): ChainTransaction {
  psbt.data.inputs.forEach((input, index) => {
    if (!input.witnessUtxo) throw new Error("Guardian PSBT missing prevout");
    if (index === 0 || input.finalScriptWitness) return;
    if (input.tapKeySig)
      psbt.updateInput(index, {
        finalScriptWitness: Buffer.from(core.encodeWitness([input.tapKeySig]), "hex"),
      });
    else psbt.finalizeInput(index);
  });
  return {
    rawHex: rawWithWitnesses(psbt).toHex(),
    prevouts: psbt.txInputs.map((input, index) => ({
      txid: Buffer.from(input.hash).reverse().toString("hex"),
      vout: input.index,
      scriptHex: psbt.data.inputs[index]!.witnessUtxo!.script.toString("hex"),
      sats: BigInt(psbt.data.inputs[index]!.witnessUtxo!.value),
    })),
  };
}
export async function signGuardianPsbt(
  psbtBase64: string,
  ledger: Ledger,
  backend: GuardianSigningBackend,
): Promise<{
  psbtBase64: string;
  transaction: ChainTransaction;
  transition: ValidatedTransition;
  signatureHex: string;
}> {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64);
  const transaction = guardianPsbtTransaction(psbt);
  const transition = core.validateGuardianTransaction(ledger, transaction);
  const raw = core.parseRawTransaction(transaction.rawHex);
  const asset = Object.values(ledger.assets).find(
    (asset) => core.outpoint(asset.vault) === core.outpoint(raw.inputs[0]!),
  )!;
  const custody = asset.config.guardianCustody!;
  const xOnly = Buffer.from(await backend.xOnlyPubkey());
  if (xOnly.toString("hex") !== custody.guardianPublicKeyHex)
    throw new Error("Guardian backend key differs from registered custody");
  const input = psbt.data.inputs[0]!;
  if (input.sighashType !== undefined && input.sighashType !== 1)
    throw new Error("Guardian requires ALL");
  const witness = [
    new Uint8Array(64),
    Buffer.from(custody.assetCommitmentHex, "hex"),
    Buffer.from(custody.executionScriptHex, "hex"),
    Buffer.from(custody.controlBlockHex, "hex"),
  ];
  const { leafHash } = core.guardianExecutionKey(witness, asset.vault.scriptHex);
  const sighash = core.taprootSignatureHash(raw, transaction.prevouts, 0, 1, leafHash);
  const signature = await backend.signTaprootScriptPath({
    sighash: Buffer.from(sighash),
    leafTapleafHash: Buffer.from(leafHash),
  });
  if (signature.length !== 64) throw new Error("Guardian signature must be 64 bytes");
  witness[0] = Buffer.concat([Buffer.from(signature), Buffer.from([1])]);
  psbt.updateInput(0, { finalScriptWitness: Buffer.from(core.encodeWitness(witness), "hex") });
  const signed = { rawHex: rawWithWitnesses(psbt).toHex(), prevouts: transaction.prevouts };
  core.validateFinalTransaction(transition.plan, signed, { ...ledger, config: asset.config });
  return {
    psbtBase64: psbt.toBase64(),
    transaction: signed,
    transition,
    signatureHex: Buffer.from(witness[0]).toString("hex"),
  };
}
