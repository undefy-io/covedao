import * as ecc from "tiny-secp256k1";
import { hash160, hash256, hex, unhex, utf8 } from "./bytes.js";
import { outpoint, sats, signNativeInput, verifySignatures } from "./wire.js";
import type { Ledger, Offer } from "./types.js";
export const offerId = (offer: Offer): string =>
  `${offer.network}:${offer.deployTxid}:${outpoint(offer.listedInput)}`;
function message(o: Offer): Uint8Array {
  return hash256(
    utf8(
      JSON.stringify([
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
      ]),
    ),
  );
}
export function verifyOffer(o: Offer): void {
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
    !Number.isInteger(o.expiryHeight) ||
    o.expiryHeight < 0 ||
    typeof o.priceSats !== "bigint" ||
    o.priceSats <= 0n ||
    o.listedInput.atoms <= 0n
  )
    throw new Error("invalid signed offer terms");
  const key = unhex(o.publicKeyHex);
  if (
    !ecc.isPoint(key) ||
    `0014${hex(hash160(key))}` !== o.sellerScriptHex ||
    o.listedInput.scriptHex !== o.sellerScriptHex ||
    !ecc.verify(message(o), key, unhex(o.signatureHex), true)
  )
    throw new Error("offer signature/owner mismatch");
  const tx = authorizationTransaction(o);
  if (tx.inputs[0]!.witness[0]?.at(-1) !== 131)
    throw new Error("offer requires SINGLE|ANYONECANPAY seller signature");
  verifySignatures(tx, [o.listedInput], outpoint(o.listedInput));
}
export async function authorizeOffer(
  terms: Omit<Offer, "publicKeyHex" | "signatureHex" | "sellerWitnessHex" | "status">,
  privateKey: Uint8Array,
): Promise<Offer> {
  const key = ecc.pointFromScalar(privateKey, true);
  if (!key) throw new Error("invalid signing key");
  const o: Offer = { ...terms, publicKeyHex: hex(key), signatureHex: "", sellerWitnessHex: [] };
  o.signatureHex = hex(ecc.sign(message(o), privateKey));
  o.sellerWitnessHex = signNativeInput(
    authorizationTransaction(o),
    [o.listedInput],
    0,
    privateKey,
    131,
  );
  verifyOffer(o);
  return o;
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
  if (existing && existing.signatureHex !== offer.signatureHex)
    throw new Error("conflicting authorization for listed outpoint");
  return {
    ...ledger,
    offers: {
      ...ledger.offers,
      [id]: { ...structuredClone(offer), status: existing?.status ?? "open" },
    },
  };
}
export function markOfferUnavailable(ledger: Ledger, id: string): Ledger {
  const offer = ledger.offers[id];
  if (!offer || offer.status !== "open") throw new Error("offer is not open");
  return { ...ledger, offers: { ...ledger.offers, [id]: { ...offer, status: "cancelPending" } } };
}

function authorizationTransaction(o: Offer) {
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
        witness: o.sellerWitnessHex.map(unhex),
      },
    ],
    outputs: [{ sats: o.priceSats + sats(o.listedInput.sats), scriptHex: o.sellerScriptHex }],
  };
}
