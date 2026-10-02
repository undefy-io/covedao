/** Private-key signing is confined to isolated tests; never exported by the package. */
import * as ecc from "tiny-secp256k1";
import { concat, hex } from "../bytes.js";
import { nativeSignatureHash } from "../wire.js";
import type { RawTransaction } from "../wire.js";
import type { Input, Offer } from "../types.js";
import { taggedHash, taprootSignatureHash } from "../taproot.js";
import { offerMessage, offerSigningTransaction, verifyOffer } from "../offers.js";
import { bip322SigningTransaction, encodeMessageWitness } from "../bip322.js";
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
function signOwner(
  tx: ReturnType<typeof offerSigningTransaction>,
  prevouts: Input[],
  privateKey: Uint8Array,
  hashType: number,
): string[] {
  if (prevouts[0]!.scriptHex.startsWith("0014"))
    return signNativeInput(tx, prevouts, 0, privateKey, hashType);
  const key = ecc.pointFromScalar(privateKey, true)!;
  const internal = key.slice(1);
  const tweaked = ecc.privateAdd(
    key[0] === 3 ? ecc.privateNegate(privateKey) : privateKey,
    taggedHash("TapTweak", internal),
  );
  if (!tweaked) throw new Error("invalid Taproot signing key");
  const signature = hex(ecc.signSchnorr(taprootSignatureHash(tx, prevouts, 0, hashType), tweaked));
  return [signature + (hashType === 0 ? "" : hashType.toString(16).padStart(2, "0"))];
}
export async function authorizeOffer(
  terms: Omit<Offer, "publicKeyHex" | "signatureHex" | "sellerWitnessHex" | "status">,
  privateKey: Uint8Array,
): Promise<Offer> {
  const key = ecc.pointFromScalar(privateKey, true);
  if (!key) throw new Error("invalid signing key");
  const o: Offer = { ...terms, publicKeyHex: hex(key), signatureHex: "", sellerWitnessHex: [] };
  const virtual = bip322SigningTransaction(o.sellerScriptHex, offerMessage(o));
  o.signatureHex = encodeMessageWitness(
    signOwner(
      virtual.tx,
      virtual.prevouts,
      privateKey,
      o.sellerScriptHex.startsWith("0014") ? 1 : 0,
    ),
  );
  o.sellerWitnessHex = signOwner(offerSigningTransaction(o), [o.listedInput], privateKey, 131);
  verifyOffer(o);
  return o;
}
