import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";

/** Verify the final transaction still spends and pays exactly the reviewed PSBT. */
export function readyTransactionId(rawHex: string, reviewedPsbt: string): string {
  if (typeof rawHex !== "string" || rawHex.length > 750000 || !/^(?:[a-f0-9]{2})+$/.test(rawHex))
    throw new Error("Invalid finalized transaction");
  const parsed = core.parseRawTransaction(rawHex);
  const transaction = bitcoin.Transaction.fromHex(rawHex);
  for (const input of transaction.ins) { input.script = Buffer.alloc(0); input.witness = []; }
  const unsigned = bitcoin.Psbt.fromBase64(reviewedPsbt).data.globalMap.unsignedTx.toBuffer();
  if (!transaction.toBuffer().equals(unsigned)) throw new Error("Final transaction differs from the reviewed transaction");
  return parsed.txid;
}
