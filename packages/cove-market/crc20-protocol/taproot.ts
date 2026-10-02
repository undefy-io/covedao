import * as ecc from "tiny-secp256k1";
import { concat, hex, le, sha256, sized, unhex, utf8 } from "./bytes.js";
import type { GuardianCustody, Input } from "./types.js";
import type { RawTransaction } from "./wire.js";

export function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const prefix = sha256(utf8(tag));
  return sha256(concat(prefix, prefix, data));
}

/** BIP341/BIP342, without annex or OP_CODESEPARATOR. Only our signing flags. */
export function taprootSignatureHash(
  tx: RawTransaction,
  prevouts: Input[],
  index: number,
  hashType: number,
  leafHash?: Uint8Array,
): Uint8Array {
  if (![0, 1, 131].includes(hashType)) throw new Error("unsupported Taproot signature flag");
  if (prevouts.length !== tx.inputs.length || !tx.inputs[index])
    throw new Error("invalid Taproot input context");
  const input = tx.inputs[index]!,
    prevout = prevouts[index]!;
  const single = hashType === 131;
  if (single && !tx.outputs[index]) throw new Error("SINGLE output missing");
  const encodeOutput = (o: RawTransaction["outputs"][number]) =>
    concat(le(o.sats, 8), sized(unhex(o.scriptHex)));
  const encodeOutpoint = (i: RawTransaction["inputs"][number]) =>
    concat(unhex(i.txid).reverse(), le(i.vout, 4));
  return taggedHash(
    "TapSighash",
    concat(
      Uint8Array.of(0, hashType),
      le(tx.version, 4),
      le(tx.locktime, 4),
      ...(single
        ? []
        : [
            sha256(concat(...tx.inputs.map(encodeOutpoint))),
            sha256(concat(...prevouts.map((p) => le(p.sats, 8)))),
            sha256(concat(...prevouts.map((p) => sized(unhex(p.scriptHex))))),
            sha256(concat(...tx.inputs.map((i) => le(i.sequence, 4)))),
            sha256(concat(...tx.outputs.map(encodeOutput))),
          ]),
      Uint8Array.of(leafHash ? 2 : 0),
      ...(single
        ? [
            encodeOutpoint(input),
            le(prevout.sats, 8),
            sized(unhex(prevout.scriptHex)),
            le(input.sequence, 4),
          ]
        : [le(index, 4)]),
      ...(single ? [sha256(encodeOutput(tx.outputs[index]!))] : []),
      ...(leafHash ? [leafHash, Uint8Array.of(0), le(0xffffffff, 4)] : []),
    ),
  );
}

/** Verify only the selected Guardian execution leaf; recovery spends are not curve transitions. */
export function guardianExecutionKey(
  witness: Uint8Array[],
  outputScriptHex: string,
): { key: Uint8Array; leafHash: Uint8Array } {
  if (witness.length !== 4) throw new Error("unsupported Taproot execution witness");
  const [, reveal, script, control] = witness;
  if (
    !script ||
    !control ||
    !reveal ||
    script.length !== 68 ||
    script[0] !== 32 ||
    script[33] !== 0x88 ||
    script[34] !== 32 ||
    script[67] !== 0xac
  )
    throw new Error("unsupported Guardian execution script");
  return executionCommitment(witness, outputScriptHex);
}

function executionCommitment(witness: Uint8Array[], outputScriptHex: string) {
  const [, reveal, script, control] = witness as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  if (hex(reveal) !== hex(script.slice(1, 33))) throw new Error("Guardian commitment mismatch");
  if (
    control.length < 33 ||
    control.length > 33 + 128 * 32 ||
    (control.length - 33) % 32 ||
    (control[0]! & 0xfe) !== 0xc0
  )
    throw new Error("invalid Taproot control block");
  const leafHash = taggedHash("TapLeaf", concat(Uint8Array.of(0xc0), sized(script)));
  let root = leafHash;
  for (let offset = 33; offset < control.length; offset += 32) {
    const branch = control.slice(offset, offset + 32);
    root = taggedHash(
      "TapBranch",
      hex(root) < hex(branch) ? concat(root, branch) : concat(branch, root),
    );
  }
  const internalKey = control.slice(1, 33);
  const tweaked = ecc.xOnlyPointAddTweak(
    internalKey,
    taggedHash("TapTweak", concat(internalKey, root)),
  );
  if (
    !tweaked ||
    `5120${hex(tweaked.xOnlyPubkey)}` !== outputScriptHex ||
    tweaked.parity !== (control[0]! & 1)
  )
    throw new Error("Taproot execution path does not match prevout");
  return { key: script.slice(35, 67), leafHash };
}

/** Validate the custody construction against independently trusted registration metadata. */
export function validateGuardianCustody(vaultScriptHex: string, custody: GuardianCustody): void {
  for (const value of [
    custody.assetCommitmentHex,
    custody.guardianPublicKeyHex,
    custody.recoveryLeafHashHex,
  ])
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("invalid Guardian custody identity");
  if (!ecc.isXOnlyPoint(unhex(custody.guardianPublicKeyHex)))
    throw new Error("invalid Guardian controller point");
  if (!/^5120[0-9a-f]{64}$/.test(vaultScriptHex))
    throw new Error("Guardian requires Taproot custody");
  const control = unhex(custody.controlBlockHex);
  if (
    control.length !== 65 ||
    hex(control.slice(1, 33)) !==
      "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0" ||
    hex(control.slice(33)) !== custody.recoveryLeafHashHex
  )
    throw new Error("Guardian NUMS/recovery branch mismatch");
  const path = guardianExecutionKey(
    [
      new Uint8Array(64),
      unhex(custody.assetCommitmentHex),
      unhex(custody.executionScriptHex),
      control,
    ],
    vaultScriptHex,
  );
  if (hex(path.key) !== custody.guardianPublicKeyHex)
    throw new Error("Guardian controller mismatch");
}
