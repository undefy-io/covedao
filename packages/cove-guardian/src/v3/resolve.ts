import * as bitcoin from "bitcoinjs-lib";
import { decodeV2, type ParsedEnvelopeV2 } from "@crclaunch/cove-wire";
import type { OutPoint } from "@crclaunch/cove-covenant";

/**
 * Independent transaction/PSBT parsing helpers (§6). The Guardian reads actual
 * PSBT inputs/outputs itself; it never trusts a builder's analysis object.
 */

export interface PsbtInputView {
  index: number;
  outpoint: OutPoint;
  script: Buffer;
  valueSats: bigint;
}

export interface PsbtOutputView {
  vout: number;
  script: Buffer;
  value: bigint;
}

/** Read every PSBT input's actual outpoint + prevout script/value. */
export function readPsbtInputs(psbt: bitcoin.Psbt): PsbtInputView[] {
  const out: PsbtInputView[] = [];
  const txInputs = psbt.txInputs;
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    const txid = Buffer.from(txInputs[i]!.hash).reverse().toString("hex");
    const wu = psbt.data.inputs[i]!.witnessUtxo;
    out.push({
      index: i,
      outpoint: { txid, vout: txInputs[i]!.index },
      script: wu ? Buffer.from(wu.script) : Buffer.alloc(0),
      valueSats: wu ? BigInt(wu.value) : 0n,
    });
  }
  return out;
}

/** Read every PSBT output's actual script + value. */
export function readPsbtOutputs(psbt: bitcoin.Psbt): PsbtOutputView[] {
  return psbt.txOutputs.map((o, vout) => ({
    vout,
    script: Buffer.from(o.script),
    value: BigInt(o.value),
  }));
}

/** Extract + decode the Cove wire-v2 envelope from output index 0 (OP_RETURN). */
export function decodeCoveOpReturn(psbt: bitcoin.Psbt): ParsedEnvelopeV2 {
  const out0 = psbt.txOutputs[0];
  if (!out0) throw new Error("NO_OUTPUT_0");
  const script = Buffer.from(out0.script);
  if (script.length < 2 || script[0] !== 0x6a) throw new Error("NO_COVE_OP_RETURN");
  const len = script[1]!;
  if (script.length !== 2 + len) throw new Error("NONCANONICAL_WIRE");
  return decodeV2(Buffer.from(script.subarray(2)));
}

/** Parse a raw transaction's OP_RETURN output 0 into a decoded envelope. */
export function decodeCoveOpReturnTx(tx: bitcoin.Transaction): ParsedEnvelopeV2 {
  const script = tx.outs[0]?.script;
  if (!script || script.length < 2 || script[0] !== 0x6a) throw new Error("NO_COVE_OP_RETURN");
  const len = script[1]!;
  if (script.length !== 2 + len) throw new Error("NONCANONICAL_WIRE");
  return decodeV2(Buffer.from(script.subarray(2)));
}

/**
 * Reconstruct the unsigned transaction from a PSBT WITHOUT finalization
 * (extractTransaction requires every input to be finalized, which is not the
 * case while the Guardian signs one input of a multi-input PSBT). The result is
 * used for the audit digest and for independent BIP341 sighash computation.
 */
export function unsignedTransaction(psbt: bitcoin.Psbt): bitcoin.Transaction {
  return bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
}

export function unsignedTxDigest(psbt: bitcoin.Psbt): string {
  return unsignedTransaction(psbt).getId();
}
