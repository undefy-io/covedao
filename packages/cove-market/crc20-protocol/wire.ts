import { concat, compact, hash256, hex, le, sized, text, unhex, utf8 } from "./bytes.js";
import type { Input, Output } from "./types.js";
import * as ecc from "tiny-secp256k1";
export const outpoint = (input: Pick<Input, "txid" | "vout">): string =>
  `${input.txid}:${input.vout}`;
export function sats(value: number | bigint): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("unsafe satoshi value");
  const n = BigInt(value);
  if (n < 0n || n > 2100000000000000n) throw new Error("satoshi value out of range");
  return n;
}
export function parseAtoms(value: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    throw new Error("amount must be a canonical positive integer");
  return BigInt(value);
}
export function spendable(script: string): boolean {
  try {
    const bytes = unhex(script);
    return bytes.length > 0 && bytes[0] !== 0x6a;
  } catch {
    return false;
  }
}
export function markerScript(json: string): string {
  const payload = utf8(json);
  if (payload.length > 65535) throw new Error("marker too long");
  return hex(
    concat(
      Uint8Array.of(0x6a),
      payload.length <= 75
        ? le(payload.length, 1)
        : payload.length <= 255
          ? concat(le(0x4c, 1), le(payload.length, 1))
          : concat(le(0x4d, 1), le(payload.length, 2)),
      payload,
    ),
  );
}
function payload(scriptHex: string): string | undefined {
  const bytes = unhex(scriptHex);
  if (bytes[0] !== 0x6a || bytes.length < 2) return;
  let offset = 2,
    length = bytes[1]!;
  if (length === 0x4c) {
    length = bytes[2]!;
    offset = 3;
  } else if (length === 0x4d) {
    length = bytes[2]! + bytes[3]! * 256;
    offset = 4;
  } else if (length > 75) return;
  if (offset + length !== bytes.length) throw new Error("malformed marker push");
  return text(bytes.slice(offset));
}
export function decodeTransaction(
  outputs: { vout: number; value_sats: number | bigint; script_hex: string }[],
) {
  const markers: { vout: number; json: string; data: Record<string, string> }[] = [];
  for (const output of outputs) {
    const json = payload(output.script_hex);
    if (!json) continue;
    let data: Record<string, string>;
    try {
      data = JSON.parse(json);
    } catch {
      if (json.includes("crc-20")) throw new Error("malformed CRC JSON");
      continue;
    }
    if (data.p !== "crc-20") continue;
    const keys =
      data.op === "deploy"
        ? ["p", "op", "tick", "type", "max", "lim", "leaf", "ordi", "btc"]
        : data.op === "mint"
          ? ["p", "op", "tick"]
          : data.op === "transfer"
            ? ["p", "op", "tick", "amt"]
            : [];
    if (
      !keys.length ||
      JSON.stringify(Object.keys(data)) !== JSON.stringify(keys) ||
      keys.some((k) => typeof data[k] !== "string") ||
      JSON.stringify(data) !== json ||
      !/^[A-Za-z0-9]{1,16}$/.test(data.tick!)
    )
      throw new Error("invalid CRC marker");
    if (sats(output.value_sats) !== 0n) throw new Error("marker must have zero sats");
    if (data.op === "transfer") parseAtoms(data.amt!);
    markers.push({ vout: output.vout, json, data });
  }
  if (markers.length !== 1) throw new Error("exactly one CRC marker required");
  const marker = markers[0]!;
  const recipient = outputs.find((o) => o.vout === marker.vout + 1);
  if (
    marker.data.op !== "deploy" &&
    (!recipient || !spendable(recipient.script_hex) || sats(recipient.value_sats) === 0n)
  )
    throw new Error("missing spendable recipient");
  return {
    markerVout: marker.vout,
    markerJson: marker.json,
    recipientVout: marker.vout + 1,
    amountAtoms: marker.data.op === "transfer" ? parseAtoms(marker.data.amt!) : undefined,
    operation: marker.data.op!,
    ticker: marker.data.tick!,
  };
}
class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || this.offset + n > this.bytes.length)
      throw new Error("truncated transaction");
    const value = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }
  integer(n: number): bigint {
    return this.take(n).reduceRight((value, byte) => value * 256n + BigInt(byte), 0n);
  }
  count(): number {
    const prefix = Number(this.integer(1));
    const value =
      prefix < 253 ? BigInt(prefix) : this.integer(prefix === 253 ? 2 : prefix === 254 ? 4 : 8);
    if (
      value > 4000000n ||
      (prefix === 253 && value < 253n) ||
      (prefix === 254 && value <= 65535n) ||
      (prefix === 255 && value <= 0xffffffffn)
    )
      throw new Error("invalid compact integer");
    return Number(value);
  }
  field(): Uint8Array {
    return this.take(this.count());
  }
}
export interface RawInput {
  txid: string;
  vout: number;
  scriptHex: string;
  sequence: number;
  witness: Uint8Array[];
}
export interface RawTransaction {
  txid: string;
  inputs: RawInput[];
  outputs: Output[];
  version: number;
  locktime: number;
}
const encodedInput = (i: RawInput) =>
  concat(unhex(i.txid).reverse(), le(i.vout, 4), sized(unhex(i.scriptHex)), le(i.sequence, 4));
const encodedOutput = (o: Output) => concat(le(o.sats, 8), sized(unhex(o.scriptHex)));
export function parseRawTransaction(rawHex: string): RawTransaction {
  const r = new Reader(unhex(rawHex));
  const version = Number(r.integer(4));
  const witness = r.bytes[r.offset] === 0 && r.bytes[r.offset + 1] === 1;
  if (witness) r.take(2);
  const count = r.count();
  if (!count) throw new Error("empty transaction");
  const inputs = Array.from({ length: count }, () => ({
    txid: hex(r.take(32).reverse()),
    vout: Number(r.integer(4)),
    scriptHex: hex(r.field()),
    sequence: Number(r.integer(4)),
    witness: [] as Uint8Array[],
  }));
  const outputCount = r.count();
  const outputs = Array.from({ length: outputCount }, () => ({
    sats: sats(r.integer(8)),
    scriptHex: hex(r.field()),
  }));
  if (witness)
    for (const input of inputs) input.witness = Array.from({ length: r.count() }, () => r.field());
  const locktime = Number(r.integer(4));
  if (r.offset !== r.bytes.length) throw new Error("trailing transaction bytes");
  const stripped = concat(
    le(version, 4),
    compact(inputs.length),
    ...inputs.map(encodedInput),
    compact(outputs.length),
    ...outputs.map(encodedOutput),
    le(locktime, 4),
  );
  return { txid: hex(hash256(stripped).reverse()), inputs, outputs, version, locktime };
}
function compactSignature(signature: Uint8Array): Uint8Array {
  if (
    signature.length < 9 ||
    signature[signature.length - 1] !== 1 ||
    signature[0] !== 0x30 ||
    signature[1] !== signature.length - 3 ||
    signature[2] !== 2
  )
    throw new Error("SIGHASH_ALL DER signature required");
  const rn = signature[3]!,
    sn = signature[5 + rn]!;
  if (signature[4 + rn] !== 2 || rn < 1 || sn < 1 || 6 + rn + sn !== signature.length - 1)
    throw new Error("invalid DER");
  const normalize = (n: Uint8Array) => {
    if (n[0]! & 0x80 || (n.length > 1 && n[0] === 0 && !(n[1]! & 0x80)))
      throw new Error("noncanonical DER");
    if (n.length === 33 && n[0] === 0) n = n.slice(1);
    if (n.length > 32) throw new Error("oversize DER integer");
    return concat(new Uint8Array(32 - n.length), n);
  };
  return concat(
    normalize(signature.slice(4, 4 + rn)),
    normalize(signature.slice(6 + rn, 6 + rn + sn)),
  );
}
export function nativeSignatureHash(
  tx: RawTransaction,
  prevouts: Input[],
  index: number,
  hashType: number,
): Uint8Array {
  if (hashType !== 1 && hashType !== 131) throw new Error("unsupported signature flag");
  const input = tx.inputs[index]!,
    prevout = prevouts[index]!;
  const anyoneCanPay = hashType === 131;
  const previous = anyoneCanPay
    ? new Uint8Array(32)
    : hash256(concat(...tx.inputs.map((i) => concat(unhex(i.txid).reverse(), le(i.vout, 4)))));
  const sequences = anyoneCanPay
    ? new Uint8Array(32)
    : hash256(concat(...tx.inputs.map((i) => le(i.sequence, 4))));
  if (anyoneCanPay && !tx.outputs[index]) throw new Error("SINGLE output missing");
  const outputs = hash256(
    concat(...(anyoneCanPay ? [tx.outputs[index]!] : tx.outputs).map(encodedOutput)),
  );
  const scriptCode = unhex(`76a914${prevout.scriptHex.slice(4)}88ac`);
  return hash256(
    concat(
      le(tx.version, 4),
      previous,
      sequences,
      unhex(input.txid).reverse(),
      le(input.vout, 4),
      sized(scriptCode),
      le(sats(prevout.sats), 8),
      le(input.sequence, 4),
      outputs,
      le(tx.locktime, 4),
      le(hashType, 4),
    ),
  );
}
export function verifySignatures(
  tx: RawTransaction,
  prevouts: Input[],
  singleAnyoneCanPayOutpoint?: string,
): void {
  if (prevouts.length !== tx.inputs.length) throw new Error("prevout count mismatch");
  tx.inputs.forEach((input, index) => {
    const prevout = prevouts[index]!;
    if (outpoint(input) !== outpoint(prevout)) throw new Error("prevout identity mismatch");
    if (
      !/^0014[0-9a-f]{40}$/.test(prevout.scriptHex) ||
      input.scriptHex !== "" ||
      input.witness.length !== 2
    )
      throw new Error("isolated ledger requires native P2WPKH inputs");
    const key = input.witness[1]!,
      signature = input.witness[0]!,
      hashType = signature[signature.length - 1]!;
    if (hex(hash160(key)) !== prevout.scriptHex.slice(4)) throw new Error("witness owner mismatch");
    if (
      hashType !== 1 &&
      !(hashType === 131 && index === 0 && singleAnyoneCanPayOutpoint === outpoint(input))
    )
      throw new Error("unauthorized signature flag");
    const normalized = signature.slice();
    normalized[normalized.length - 1] = 1;
    if (
      !ecc.verify(
        nativeSignatureHash(tx, prevouts, index, hashType),
        key,
        compactSignature(normalized),
        true,
      )
    )
      throw new Error("invalid transaction signature");
  });
}
export function signNativeInput(
  tx: RawTransaction,
  prevouts: Input[],
  index: number,
  privateKey: Uint8Array,
  hashType: number,
): string[] {
  const key = ecc.pointFromScalar(privateKey, true);
  if (!key) throw new Error("invalid key");
  const signature = ecc.sign(nativeSignatureHash(tx, prevouts, index, hashType), privateKey);
  const integer = (raw: Uint8Array) => {
    let offset = 0;
    while (offset < raw.length - 1 && raw[offset] === 0) offset++;
    const n = raw.slice(offset),
      positive = n[0]! & 128 ? concat(Uint8Array.of(0), n) : n;
    return concat(Uint8Array.of(2, positive.length), positive);
  };
  const der = concat(integer(signature.slice(0, 32)), integer(signature.slice(32)));
  return [hex(concat(Uint8Array.of(0x30, der.length), der, Uint8Array.of(hashType))), hex(key)];
}
import { hash160 } from "./bytes.js";
