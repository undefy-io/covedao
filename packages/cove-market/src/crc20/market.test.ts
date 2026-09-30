import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { createCrcFill, crcCancelMessage, crcListingMessage, validateCrcListing, verifyCrcCancellation, verifyCrcFillSignatures, verifyCrcFillTransaction, verifyCrcListingAuthorization, verifyCurrentCrcFunding } from "./market.js";
import { signBip322P2wpkh } from "../order/signature.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const key = ECPairFactory(ecc);
const seller = key.fromPrivateKey(Buffer.alloc(32, 0x32));
const buyer = key.fromPrivateKey(Buffer.alloc(32, 0x33));
const protocol = key.fromPrivateKey(Buffer.alloc(32, 0x34));
const sellerScript = bitcoin.payments.p2wpkh({ pubkey: seller.publicKey }).output!.toString("hex");
const buyerScript = bitcoin.payments.p2wpkh({ pubkey: buyer.publicKey }).output!.toString("hex");
const protocolScript = bitcoin.payments.p2wpkh({ pubkey: protocol.publicKey }).output!.toString("hex");
const deployTxid = "a".repeat(64);
const listing = {
  id: "11111111-1111-4111-8111-111111111111",
  network: "regtest" as const,
  deployTxid,
  ticker: "COVE",
  sellerScriptHex: sellerScript,
  sellerPayoutScriptHex: sellerScript,
  sellerAnchorTxid: "b".repeat(64),
  sellerAnchorVout: 0,
  sellerAnchorSats: 10_000,
  amountAtoms: 100_000_000_000n,
  priceSats: 5_000,
  protocolFeeSats: 600,
  expiresAtHeight: 200n,
};
const asset = { network: "regtest" as const, deployTxid, ticker: "COVE", protocolVersion: 2 as const,
  tokenOutpoint: `${listing.sellerAnchorTxid}:0`, tokenScriptHex: sellerScript, tokenAtoms: listing.amountAtoms };
const sellerFunding = { txid: listing.sellerAnchorTxid, vout: 0, valueSats: 10_000, scriptHex: sellerScript,
  tokenAtoms: listing.amountAtoms, tokenDeploymentTxid: deployTxid };
const buyerFunding = { txid: "c".repeat(64), vout: 1, valueSats: 10_000, scriptHex: buyerScript, tokenAtoms: 0n };
const options = { listing, asset, sellerFunding, buyerFunding: [buyerFunding], buyerScriptHex: buyerScript, protocolScriptHex: protocolScript, recipientSats: 1_000, minerFeeSats: 400, currentHeight: 100n };

describe("Cove CRC marketplace exact fill", () => {
  it("accepts a registered Cove v2 asset with the exact indexed token outpoint", () => {
    expect(() => validateCrcListing(listing, asset, 100n)).not.toThrow();
    const signed = signBip322P2wpkh(Buffer.alloc(32, 0x32), Buffer.from(sellerScript, "hex"), crcListingMessage(listing));
    expect(() => verifyCrcListingAuthorization(listing, signed)).not.toThrow();
    expect(() => verifyCrcListingAuthorization({ ...listing, priceSats: 5_001 }, signed)).toThrow();
    const cancel = signBip322P2wpkh(Buffer.alloc(32, 0x32), Buffer.from(sellerScript, "hex"), crcCancelMessage(listing));
    expect(() => verifyCrcCancellation(listing, cancel)).not.toThrow();
    expect(() => verifyCrcCancellation({ ...listing, id: "22222222-2222-4222-8222-222222222222" }, cancel)).toThrow();
  });

  it("rejects external ids, v1, another network, missing or mismatched token outpoints", () => {
    expect(() => validateCrcListing(listing, { ...asset, deployTxid: "d".repeat(64) }, 100n)).toThrow();
    expect(() => validateCrcListing(listing, { ...asset, network: "signet" }, 100n)).toThrow();
    expect(() => validateCrcListing(listing, { ...asset, protocolVersion: 1 }, 100n)).toThrow();
    expect(() => validateCrcListing(listing, { ...asset, tokenAtoms: 0n }, 100n)).toThrow();
    expect(() => validateCrcListing(listing, { ...asset, tokenOutpoint: `${"f".repeat(64)}:0` }, 100n)).toThrow();
    expect(() => validateCrcListing(listing, { ...asset, tokenScriptHex: buyerScript }, 100n)).toThrow();
    expect(() => validateCrcListing(listing, asset, 200n)).toThrow();
  });

  it("builds exact seller payout and recipient, with seller anchor first", () => {
    const fill = createCrcFill(options);
    const tx = bitcoin.Transaction.fromBuffer(fill.psbt.data.globalMap.unsignedTx.toBuffer());
    expect(Buffer.from(tx.ins[0]!.hash).reverse().toString("hex")).toBe(listing.sellerAnchorTxid);
    expect(tx.outs[1]!.script.toString("hex")).toBe(buyerScript);
    expect(tx.outs[2]!.value).toBe(15_000);
    expect(tx.outs[2]!.script.toString("hex")).toBe(sellerScript);
    expect(tx.outs[3]!.value).toBe(600);
    expect(tx.outs[0]!.script.toString("hex")).toContain(Buffer.from('"v":2').toString("hex"));
    expect(() => verifyCrcFillTransaction(fill.psbt, options)).not.toThrow();
  });

  it("rejects wrong recipient, payout, fee, outpoint, amount and network", () => {
    const fill = createCrcFill(options);
    for (const patch of [
      { buyerScriptHex: sellerScript },
      { listing: { ...listing, priceSats: 5_001 } },
      { listing: { ...listing, amountAtoms: 200_000_000_000n } },
      { listing: { ...listing, sellerAnchorTxid: "f".repeat(64) } },
      { asset: { ...asset, tokenOutpoint: `${"f".repeat(64)}:0` } },
      { protocolScriptHex: buyerScript },
    ]) expect(() => verifyCrcFillTransaction(fill.psbt, { ...options, ...patch })).toThrow();
  });

  it("requires both online signatures over every input and output", () => {
    const fill = createCrcFill(options);
    expect(() => verifyCrcFillSignatures(fill.psbt, 1)).toThrow();
    fill.psbt.signInput(0, seller);
    expect(() => verifyCrcFillSignatures(fill.psbt, 1)).toThrow();
    fill.psbt.signInput(1, buyer);
    expect(() => verifyCrcFillSignatures(fill.psbt, 1)).not.toThrow();
    const mutated = fill.psbt.clone();
    const tx = bitcoin.Transaction.fromBuffer(mutated.data.globalMap.unsignedTx.toBuffer());
    tx.outs[2]!.value -= 1;
    const other = createCrcFill({ ...options, listing: { ...listing, priceSats: 4_999 }, buyerFunding: [{ ...buyerFunding, valueSats: 10_001 }] });
    other.psbt.data.inputs[0]!.partialSig = fill.psbt.data.inputs[0]!.partialSig;
    expect(() => verifyCrcFillSignatures(other.psbt, 1)).toThrow();
  });

  it("rejects a reused seller signature with a different buyer input", () => {
    const fill = createCrcFill(options);
    fill.psbt.signInput(0, seller);
    const competing = createCrcFill({ ...options, buyerFunding: [{ ...buyerFunding, txid: "e".repeat(64) }] });
    competing.psbt.data.inputs[0]!.partialSig = fill.psbt.data.inputs[0]!.partialSig;
    expect(() => verifyCrcFillSignatures(competing.psbt, 1)).toThrow();
  });

  it("checks every funding outpoint against Core's current UTXO set", async () => {
    const core = { getTxout: async (txid: string) => ({
      scriptPubKeyHex: txid === sellerFunding.txid ? sellerScript : buyerScript,
      valueSats: BigInt(txid === sellerFunding.txid ? sellerFunding.valueSats : buyerFunding.valueSats),
      confirmations: 1,
    }) };
    await expect(verifyCurrentCrcFunding(core, options)).resolves.toBeUndefined();
    await expect(verifyCurrentCrcFunding({ getTxout: async () => null }, options)).rejects.toThrow();
    await expect(verifyCurrentCrcFunding(core, { ...options, buyerFunding: [sellerFunding] })).rejects.toThrow();
  });
});
