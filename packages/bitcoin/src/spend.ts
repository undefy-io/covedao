import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { isP2TR, isP2WPKH } from "./dust.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

/**
 * How a wallet-owned output is spent.
 *
 * Cove only ever understood P2WPKH, which is a minority of real wallets.
 * Xverse and Magic Eden hand out `p2sh-p2wpkh` payment addresses, and every
 * ordinals address in every wallet is taproot — so most people could not fund
 * a buy, and nobody with a taproot carrier could ever spend the tokens they
 * had bought. These three kinds cover every address the supported wallets
 * produce.
 *
 * Script-path taproot is deliberately absent: the only script-path spend in
 * Cove is the backing vault, which the Guardian signs itself and which never
 * belongs to a user.
 */
export type SpendKind = "p2wpkh" | "p2sh-p2wpkh" | "p2tr";

/** P2SH wrapping a witness program: OP_HASH160 <20 bytes> OP_EQUAL. */
export function isP2SH(script: Uint8Array): boolean {
  return script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87;
}

/**
 * Which kind of spend an output script needs, or null when Cove cannot sign
 * it. A null is a refusal, never a default: guessing at an unknown script
 * produces a PSBT no wallet can sign and an error nobody can act on.
 */
export function spendKindOf(script: Uint8Array): SpendKind | null {
  if (isP2WPKH(script)) return "p2wpkh";
  if (isP2TR(script)) return "p2tr";
  if (isP2SH(script)) return "p2sh-p2wpkh";
  return null;
}

/** The x-only (32-byte) form of a public key, as Taproot uses. */
export function xOnly(publicKey: Uint8Array): Buffer {
  const key = Buffer.from(publicKey);
  return key.length === 32 ? key : key.subarray(1, 33);
}

/**
 * The scriptPubKey a public key controls, for each kind of address a wallet
 * may report. Used to check that the key a wallet gave really does own the
 * outputs being spent — a mismatch means an unsignable PSBT, and finding that
 * out at signing time is far too late.
 */
export function scriptForKind(
  kind: SpendKind,
  publicKey: Uint8Array,
  network: bitcoin.networks.Network,
): Buffer {
  const pubkey = Buffer.from(publicKey);
  switch (kind) {
    case "p2wpkh":
      return bitcoin.payments.p2wpkh({ pubkey, network }).output!;
    case "p2sh-p2wpkh":
      return bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey, network }),
        network,
      }).output!;
    case "p2tr":
      return bitcoin.payments.p2tr({ internalPubkey: xOnly(pubkey), network }).output!;
  }
}

export interface SpendableInput {
  txid: string;
  vout: number;
  script: Buffer;
  valueSats: bigint;
  /**
   * The owner's public key. Required for anything but a bare P2WPKH: a nested
   * segwit input needs its redeemScript, and a Taproot input needs its
   * internal key, and neither is recoverable from the scriptPubKey alone.
   */
  publicKey?: Buffer;
}

/**
 * The PSBT input fields a wallet needs in order to sign this output.
 *
 * Without them the PSBT is silently unsignable: a wallet asked to sign a
 * nested-segwit input with no redeemScript, or a Taproot input with no
 * internal key, simply returns the PSBT untouched.
 */
export function psbtInputFor(
  input: SpendableInput,
  network: bitcoin.networks.Network,
): Parameters<bitcoin.Psbt["addInput"]>[0] {
  const kind = spendKindOf(input.script);
  if (kind === null) {
    throw new Error(
      `cannot spend ${input.txid}:${input.vout}: unsupported address type ` +
        `(script ${input.script.toString("hex").slice(0, 16)}…)`,
    );
  }

  const base = {
    hash: input.txid,
    index: input.vout,
    witnessUtxo: { script: input.script, value: Number(input.valueSats) },
  };

  if (kind === "p2wpkh") return base;

  if (!input.publicKey) {
    throw new Error(
      `cannot spend ${input.txid}:${input.vout}: a ${kind} input needs the owner's public key`,
    );
  }
  // The key must actually own the output, or the wallet is being handed an
  // input it cannot sign.
  const derived = scriptForKind(kind, input.publicKey, network);
  if (!derived.equals(input.script)) {
    throw new Error(
      `cannot spend ${input.txid}:${input.vout}: the supplied public key does not control it`,
    );
  }

  if (kind === "p2sh-p2wpkh") {
    return {
      ...base,
      redeemScript: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(input.publicKey), network })
        .output!,
    };
  }
  return { ...base, tapInternalKey: xOnly(input.publicKey) };
}

/** Extra vbytes an input of each kind adds, beyond the 41-byte base. */
export const WITNESS_VBYTES: Record<SpendKind, number> = {
  // 108 witness bytes / 4
  p2wpkh: 27,
  // same witness, plus a 23-byte scriptSig carrying the redeemScript
  "p2sh-p2wpkh": 50,
  // 66 witness bytes / 4
  p2tr: 17,
};

/** Total vbytes for a signed input of this kind (41 base + witness). */
export function inputVbytes(kind: SpendKind): number {
  return 41 + WITNESS_VBYTES[kind];
}

export type SignatureProblem =
  | { ok: true }
  | { ok: false; reason: "UNSIGNED" | "NOT_SIGHASH_ALL" | "INVALID" | "UNSUPPORTED"; detail: string };

/**
 * Check a wallet's signature on one input.
 *
 * Two things are being asserted, and both matter. The signature must be valid
 * for the key that owns the output — otherwise the transaction is not
 * spendable. And it must commit to ALL outputs: a signature over fewer of them
 * lets anyone rewrite where the money goes, which is precisely the
 * free-floating order-book behaviour Cove refuses to build on.
 *
 * Taproot signs SIGHASH_DEFAULT as a bare 64-byte signature, which commits to
 * every input and output exactly as SIGHASH_ALL does; a 65th byte carries an
 * explicit sighash flag, and only 0x01 is accepted there.
 */
export function checkSpendSignature(psbt: bitcoin.Psbt, index: number): SignatureProblem {
  return checkSignatureWithSighash(psbt, index, bitcoin.Transaction.SIGHASH_ALL);
}

/**
 * SIGHASH_SINGLE | SIGHASH_ANYONECANPAY: the Ordinals-market listing
 * signature. It commits to this input and to the ONE output at the same index
 * (the seller's payout), and to nothing else, so a buyer can later add their
 * own inputs and outputs around it without the seller signing again.
 */
export const SIGHASH_SINGLE_ANYONECANPAY =
  bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY;

/**
 * A listing presignature: present, SIGHASH_SINGLE|ANYONECANPAY exactly, and
 * cryptographically valid for the key that owns the input.
 */
export function checkListingSignature(psbt: bitcoin.Psbt, index: number): SignatureProblem {
  return checkSignatureWithSighash(psbt, index, SIGHASH_SINGLE_ANYONECANPAY);
}

/**
 * One input's signature, required to carry exactly `sighash`. For
 * SIGHASH_ALL a bare 64-byte Taproot signature (SIGHASH_DEFAULT) is accepted,
 * since it commits to exactly what SIGHASH_ALL does.
 */
function checkSignatureWithSighash(psbt: bitcoin.Psbt, index: number, sighash: number): SignatureProblem {
  const input = psbt.data.inputs[index];
  if (!input) return { ok: false, reason: "UNSIGNED", detail: `input ${index} does not exist` };
  const all = sighash === bitcoin.Transaction.SIGHASH_ALL;
  const wanted = all ? "SIGHASH_ALL" : `sighash 0x${sighash.toString(16)}`;

  const script = input.witnessUtxo?.script;
  const kind = script ? spendKindOf(script) : null;
  if (kind === null) {
    return { ok: false, reason: "UNSUPPORTED", detail: `input ${index} has an unsupported script` };
  }

  if (kind === "p2tr") {
    const sig = input.tapKeySig;
    if (!sig || sig.length === 0) {
      return { ok: false, reason: "UNSIGNED", detail: `input ${index} unsigned` };
    }
    if (sig.length !== 64 && sig.length !== 65) {
      return { ok: false, reason: "INVALID", detail: `input ${index} taproot signature is malformed` };
    }
    const hashType = sig.length === 65 ? sig[64]! : bitcoin.Transaction.SIGHASH_DEFAULT;
    const matches = all
      ? hashType === bitcoin.Transaction.SIGHASH_DEFAULT || hashType === sighash
      : sig.length === 65 && hashType === sighash;
    if (!matches) {
      return {
        ok: false,
        reason: "NOT_SIGHASH_ALL",
        detail: `input ${index} taproot sighash 0x${hashType.toString(16)} is not ${wanted}`,
      };
    }
    // Verified directly against the output key in the scriptPubKey, so it
    // does not depend on tapInternalKey, which a finalizing wallet clears.
    let ok = false;
    try {
      const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
      const prevScripts = psbt.data.inputs.map((i) => Buffer.from(i.witnessUtxo!.script));
      const values = psbt.data.inputs.map((i) => i.witnessUtxo!.value);
      const digest = tx.hashForWitnessV1(index, prevScripts, values, hashType);
      ok = ecc.verifySchnorr(digest, Buffer.from(script!.subarray(2, 34)), Buffer.from(sig.subarray(0, 64)));
    } catch {
      ok = false;
    }
    return ok
      ? { ok: true }
      : { ok: false, reason: "INVALID", detail: `input ${index} signature invalid` };
  }

  // p2wpkh and p2sh-p2wpkh are both ECDSA over a witness-v0 sighash.
  if (!input.partialSig || input.partialSig.length === 0) {
    return { ok: false, reason: "UNSIGNED", detail: `input ${index} unsigned` };
  }
  const sig = Buffer.from(input.partialSig[0]!.signature);
  if (sig.length === 0 || sig[sig.length - 1] !== sighash) {
    return { ok: false, reason: "NOT_SIGHASH_ALL", detail: `input ${index} is not ${wanted}` };
  }
  if (kind === "p2sh-p2wpkh" && !input.redeemScript) {
    return {
      ok: false,
      reason: "INVALID",
      detail: `input ${index} is nested segwit but carries no redeemScript`,
    };
  }
  let ok = false;
  try {
    ok = psbt.validateSignaturesOfInput(index, (pubkey, msghash, signature) =>
      ecc.verify(msghash, pubkey, signature),
    );
  } catch {
    ok = false;
  }
  return ok ? { ok: true } : { ok: false, reason: "INVALID", detail: `input ${index} signature invalid` };
}

/**
 * Undo a wallet's finalization of its own inputs.
 *
 * Some wallets hand back signed inputs already finalized — the signature moved
 * into finalScriptWitness and the partialSig / tapKeySig fields cleared. Every
 * check here reads those fields, so a finalized input looked unsigned and a
 * good transaction was refused. Single-key spends are unambiguous to restore:
 * a P2WPKH or nested-segwit witness is [sig, pubkey] and a key-path Taproot
 * witness is [sig]. Anything else (the vault's script path) is left alone.
 */
export function unfinalizeKeyInputs(psbt: bitcoin.Psbt): void {
  psbt.data.inputs.forEach((input) => {
    if (!input.finalScriptWitness || input.partialSig?.length || input.tapKeySig) return;
    const script = input.witnessUtxo?.script;
    if (!script) return;
    const kind = spendKindOf(script);
    const stack = witnessStack(Buffer.from(input.finalScriptWitness));
    const restored: Record<string, unknown> = {};
    if ((kind === "p2wpkh" || kind === "p2sh-p2wpkh") && stack.length === 2) {
      const pubkey = stack[1]!;
      restored.partialSig = [{ pubkey, signature: stack[0]! }];
      if (kind === "p2sh-p2wpkh") restored.redeemScript = bitcoin.payments.p2wpkh({ pubkey }).output!;
    } else if (kind === "p2tr" && stack.length === 1 && (stack[0]!.length === 64 || stack[0]!.length === 65)) {
      restored.tapKeySig = stack[0]!;
    } else {
      return;
    }
    // bitcoinjs will not overwrite final fields through updateInput.
    delete (input as { finalScriptWitness?: Buffer }).finalScriptWitness;
    delete (input as { finalScriptSig?: Buffer }).finalScriptSig;
    Object.assign(input, restored);
  });
}

function witnessStack(buf: Buffer): Buffer[] {
  let o = 0;
  const varint = (): number => {
    const b = buf[o++]!;
    if (b < 0xfd) return b;
    if (b === 0xfd) { const v = buf.readUInt16LE(o); o += 2; return v; }
    const v = buf.readUInt32LE(o); o += 4; return v;
  };
  const n = varint();
  const out: Buffer[] = [];
  for (let k = 0; k < n; k++) {
    const len = varint();
    out.push(buf.subarray(o, o + len));
    o += len;
  }
  return out;
}
