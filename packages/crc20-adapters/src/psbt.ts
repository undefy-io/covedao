import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
export function rawWithWitnesses(psbt: bitcoin.Psbt): bitcoin.Transaction {
  const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  psbt.data.inputs.forEach((input, index) => {
    if (input.finalScriptSig) tx.setInputScript(index, input.finalScriptSig);
    if (input.finalScriptWitness)
      tx.setWitness(
        index,
        core.decodeWitness(input.finalScriptWitness.toString("hex")).map((w) => Buffer.from(w)),
      );
  });
  return tx;
}
