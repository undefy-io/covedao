import { compact, concat, hex, le, sized, unhex, utf8 } from "./bytes.js";
import { taggedHash } from "./taproot.js";
import { parseRawTransaction, verifySignatures, type RawTransaction } from "./wire.js";
import type { Input } from "./types.js";

/** Canonical consensus-encoded witness bytes; the wallet adapter handles base64/prefix framing. */
export function encodeMessageWitness(witness: string[]): string {
  return hex(concat(compact(witness.length), ...witness.map((w) => sized(unhex(w)))));
}
export function decodeMessageWitness(signatureHex: string): Uint8Array[] {
  if (!/^(?:[0-9a-f]{2}){1,256}$/.test(signatureHex))
    throw new Error("invalid BIP322 witness encoding");
  const bytes = unhex(signatureHex);
  // The supported native witness templates have only small, single-byte CompactSize fields.
  const count = bytes[0]!;
  if (count !== 1 && count !== 2) throw new Error("unsupported BIP322 witness count");
  let offset = 1;
  const witness: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    const length = bytes[offset++];
    if (length === undefined || length > 80 || offset + length > bytes.length)
      throw new Error("truncated or noncanonical BIP322 witness");
    witness.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  if (offset !== bytes.length) throw new Error("trailing BIP322 witness bytes");
  return witness;
}

export function bip322SigningTransaction(
  scriptHex: string,
  message: string,
): { tx: RawTransaction; prevouts: Input[] } {
  if (!/^0014[0-9a-f]{40}$/.test(scriptHex) && !/^5120[0-9a-f]{64}$/.test(scriptHex))
    throw new Error("unsupported BIP322 signing script");
  const spend = parseRawTransaction(
    hex(
      concat(
        le(0, 4),
        compact(1),
        new Uint8Array(32),
        le(0xffffffff, 4),
        sized(concat(Uint8Array.of(0, 32), taggedHash("BIP0322-signed-message", utf8(message)))),
        le(0, 4),
        compact(1),
        le(0, 8),
        sized(unhex(scriptHex)),
        le(0, 4),
      ),
    ),
  );
  const prevout: Input = { txid: spend.txid, vout: 0, sats: 0n, scriptHex };
  return {
    tx: {
      txid: "",
      version: 0,
      locktime: 0,
      inputs: [{ txid: spend.txid, vout: 0, sequence: 0, scriptHex: "", witness: [] }],
      outputs: [{ sats: 0n, scriptHex: "6a" }],
    },
    prevouts: [prevout],
  };
}

/** BIP322 simple, limited to native P2WPKH and Taproot key-path owners. */
export function verifyMessageAuthorization(
  scriptHex: string,
  message: string,
  signatureHex: string,
): void {
  const { tx, prevouts } = bip322SigningTransaction(scriptHex, message);
  const witness = decodeMessageWitness(signatureHex);
  if (
    (scriptHex.startsWith("0014") && witness.length !== 2) ||
    (scriptHex.startsWith("5120") && witness.length !== 1)
  )
    throw new Error("unsupported BIP322 witness template");
  tx.inputs[0]!.witness = witness;
  verifySignatures(tx, prevouts);
}
