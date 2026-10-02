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
/** Normalize wallet-returned public keys and prove ownership before any prompt. */
export function canonicalOfferPublicKey(publicKeyHex: string, sellerScriptHex: string): string {
  if (!/^(?:[0-9a-f]{64}|0[23][0-9a-f]{64})$/.test(publicKeyHex))
    throw new Error("invalid wallet public key encoding");
  const canonical = sellerScriptHex.startsWith("5120")
    ? `02${publicKeyHex.length === 64 ? publicKeyHex : publicKeyHex.slice(2)}`
    : publicKeyHex;
  if (ownerScript(unhex(canonical), sellerScriptHex) !== sellerScriptHex)
    throw new Error("wallet key/offer owner mismatch");
  return canonical;
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
function matchesAllocation(ledger: Ledger, offer: Offer): boolean {
  const allocation = ledger.allocations[outpoint(offer.listedInput)],
    asset = ledger.assets[offer.deployTxid];
  return Boolean(
    asset &&
    offer.network === asset.config.network &&
    offer.ticker === asset.config.ticker &&
    allocation &&
    allocation.deployTxid === offer.deployTxid &&
    allocation.atoms === offer.listedInput.atoms &&
    allocation.sats === sats(offer.listedInput.sats) &&
    allocation.scriptHex === offer.sellerScriptHex,
  );
}
/** Replay previously admitted signed terms, including expired terms needed for confirmed fills.
 * New publication must use registerOffer, which checks current allocation and expiry. */
export function prepareOfferRehydration(
  ledger: Ledger,
  authorizations: readonly Offer[],
): (state: Ledger, outpoints?: Iterable<string>) => Ledger {
  const byOutpoint = new Map<string, Offer>();
  for (const authorization of authorizations) {
    const offer = structuredClone(authorization);
    verifyOffer(offer);
    const key = outpoint(offer.listedInput),
      existing = ledger.offers[offerId(offer)] ?? byOutpoint.get(key);
    if (existing && offerMessage(existing) !== offerMessage(offer))
      throw new Error("conflicting authorization for listed outpoint");
    const first = byOutpoint.get(key);
    byOutpoint.set(
      key,
      first
        ? {
            ...first,
            status:
              first.status === "cancelPending" || offer.status === "cancelPending"
                ? "cancelPending"
                : "open",
          }
        : offer,
    );
  }
  return (state, outpoints = Object.keys(state.allocations)) => {
    let next = state;
    for (const key of outpoints) {
      const offer = byOutpoint.get(key);
      if (!offer || !matchesAllocation(next, offer)) continue;
      const id = offerId(offer),
        existing = next.offers[id];
      if (existing) {
        if (offerMessage(existing) !== offerMessage(offer))
          throw new Error("conflicting authorization for listed outpoint");
        if (offer.status === "cancelPending" && existing.status === "open")
          next = markOfferUnavailable(next, id);
        continue;
      }
      next = {
        ...next,
        offers: {
          ...next.offers,
          [id]: {
            ...structuredClone(offer),
            status: offer.status === "cancelPending" ? "cancelPending" : "open",
          },
        },
      };
    }
    return next;
  };
}
export function rehydrateOfferAuthorizations(
  ledger: Ledger,
  authorizations: readonly Offer[],
): Ledger {
  return prepareOfferRehydration(ledger, authorizations)(ledger);
}
export async function registerOffer(ledger: Ledger, offer: Offer): Promise<Ledger> {
  verifyOffer(offer);
  if (!matchesAllocation(ledger, offer) || (ledger.tip && ledger.tip.height >= offer.expiryHeight))
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
