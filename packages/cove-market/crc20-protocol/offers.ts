import * as ecc from "tiny-secp256k1";
import { hash160, hex, unhex } from "./bytes.js";
import { outpoint, sats, verifySignatures } from "./wire.js";
import { verifyMessageAuthorization } from "./bip322.js";
import { taggedHash } from "./taproot.js";
import type { Ledger, Offer } from "./types.js";
export const offerId = (offer: Offer): string =>
  `${offer.network}:${offer.deployTxid}:${outpoint(offer.listedInput)}`;
export type OfferTerms = Omit<Offer, "signatureHex" | "sellerWitnessHex" | "status">;
export function offerMessage(o: OfferTerms): string {
  validateOfferTerms(o);
  return JSON.stringify([
    "cove-crc-offer-v1",
    o.network,
    o.deployTxid,
    o.ticker,
    o.listedInput.txid,
    o.listedInput.vout,
    o.listedInput.atoms.toString(),
    sats(o.listedInput.sats).toString(),
    o.listedInput.scriptHex,
    o.sellerScriptHex,
    o.priceSats.toString(),
    o.expiryHeight,
    o.publicKeyHex,
  ]);
}
export function attachOfferAuthorization(
  terms: OfferTerms,
  signatureHex: string,
  sellerWitnessHex: string[],
): Offer {
  const offer: Offer = {
    ...structuredClone(terms),
    signatureHex,
    sellerWitnessHex: [...sellerWitnessHex],
  };
  verifyOffer(offer);
  return offer;
}
function ownerScript(key: Uint8Array, script: string): string {
  if (key.length !== 33 || !ecc.isPoint(key)) throw new Error("invalid owner public key");
  if (script.startsWith("0014")) return `0014${hex(hash160(key))}`;
  if (script.startsWith("5120")) {
    const internal = key.slice(1);
    const output = ecc.xOnlyPointAddTweak(internal, taggedHash("TapTweak", internal));
    if (output) return `5120${hex(output.xOnlyPubkey)}`;
  }
  throw new Error("unsupported offer owner script");
}
export function validateOfferTerms(o: OfferTerms & { status?: Offer["status"] }): void {
  const allowed = [
    "network",
    "deployTxid",
    "ticker",
    "listedInput",
    "sellerScriptHex",
    "priceSats",
    "expiryHeight",
    "publicKeyHex",
    "signatureHex",
    "sellerWitnessHex",
    "status",
  ];
  if (
    Object.keys(o).some((k) => !allowed.includes(k)) ||
    !["regtest", "signet", "testnet", "bitcoin"].includes(o.network) ||
    !/^[0-9a-f]{64}$/.test(o.deployTxid) ||
    !Number.isSafeInteger(o.expiryHeight) ||
    o.expiryHeight < 0 ||
    typeof o.priceSats !== "bigint" ||
    o.priceSats <= 0n ||
    typeof o.listedInput.atoms !== "bigint" ||
    o.listedInput.atoms <= 0n ||
    !/^[A-Za-z0-9]{1,16}$/.test(o.ticker) ||
    !/^[0-9a-f]{64}$/.test(o.listedInput.txid) ||
    !Number.isSafeInteger(o.listedInput.vout) ||
    o.listedInput.vout < 0 ||
    o.listedInput.vout > 0xffffffff ||
    (o.status !== undefined && !["open", "cancelPending", "cancelled", "filled"].includes(o.status))
  )
    throw new Error("invalid signed offer terms");
  const key = unhex(o.publicKeyHex);
  if (
    ownerScript(key, o.sellerScriptHex) !== o.sellerScriptHex ||
    o.listedInput.scriptHex !== o.sellerScriptHex
  )
    throw new Error("offer signature/owner mismatch");
  sats(o.priceSats + sats(o.listedInput.sats));
}

export function verifyOffer(o: Offer): void {
  validateOfferTerms(o);
  verifyMessageAuthorization(o.sellerScriptHex, offerMessage(o), o.signatureHex);
  const tx = offerSigningTransaction(o, o.sellerWitnessHex);
  if (tx.inputs[0]!.witness[0]?.at(-1) !== 131)
    throw new Error("offer requires SINGLE|ANYONECANPAY seller signature");
  verifySignatures(tx, [o.listedInput], outpoint(o.listedInput));
}
export async function registerOffer(ledger: Ledger, offer: Offer): Promise<Ledger> {
  verifyOffer(offer);
  const allocation = ledger.allocations[outpoint(offer.listedInput)],
    asset = ledger.assets[offer.deployTxid];
  if (
    !asset ||
    offer.network !== asset.config.network ||
    offer.ticker !== asset.config.ticker ||
    !allocation ||
    allocation.deployTxid !== offer.deployTxid ||
    allocation.atoms !== offer.listedInput.atoms ||
    allocation.sats !== sats(offer.listedInput.sats) ||
    allocation.scriptHex !== offer.sellerScriptHex ||
    (ledger.tip && ledger.tip.height >= offer.expiryHeight)
  )
    throw new Error("offer does not match current chain allocation");
  const id = offerId(offer);
  const existing = ledger.offers[id];
  if (existing) {
    if (offerMessage(existing) !== offerMessage(offer))
      throw new Error("conflicting authorization for listed outpoint");
    return ledger;
  }
  return {
    ...ledger,
    offers: {
      ...ledger.offers,
      [id]: { ...structuredClone(offer), status: "open" },
    },
  };
}
export function markOfferUnavailable(ledger: Ledger, id: string): Ledger {
  const offer = ledger.offers[id];
  if (!offer || offer.status !== "open") throw new Error("offer is not open");
  return { ...ledger, offers: { ...ledger.offers, [id]: { ...offer, status: "cancelPending" } } };
}

export function offerSigningTransaction(o: OfferTerms, sellerWitnessHex: string[] = []) {
  validateOfferTerms(o);
  return {
    txid: "",
    version: 2,
    locktime: 0,
    inputs: [
      {
        txid: o.listedInput.txid,
        vout: o.listedInput.vout,
        scriptHex: "",
        sequence: 0xfffffffe,
        witness: sellerWitnessHex.map(unhex),
      },
    ],
    outputs: [{ sats: o.priceSats + sats(o.listedInput.sats), scriptHex: o.sellerScriptHex }],
  };
}
