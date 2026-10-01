import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { createCrcFill, crcCancelMessage as serverCancel, crcListingMessage as serverListing,
  crcMarketFee as serverFee,
  verifyCrcFillTransaction as serverVerify } from "./market.js";
import { crcCancelMessage, crcListingMessage, crcMarketFee, verifyCrcFillTransaction } from "./browser.js";

const deployTxid = "a".repeat(64);
const sellerScript = `0014${"b".repeat(40)}`;
const buyerScript = `0014${"c".repeat(40)}`;
const protocolScript = `0014${"d".repeat(40)}`;
const listing = {
  id: "11111111-1111-4111-8111-111111111111", network: "regtest" as const,
  deployTxid, ticker: "COVE", sellerScriptHex: sellerScript,
  sellerPayoutScriptHex: sellerScript, sellerAnchorTxid: "e".repeat(64),
  sellerAnchorVout: 0, sellerAnchorSats: 10_000,
  amountAtoms: 100_000_000_000n, priceSats: 5_000,
  protocolFeeSats: 1_000, expiresAtHeight: 200n,
};
const asset = { network: "regtest" as const, deployTxid, ticker: "COVE",
  protocolVersion: 3, tokenOutpoint: `${listing.sellerAnchorTxid}:0`,
  tokenScriptHex: sellerScript, tokenAtoms: listing.amountAtoms,
  protocolScriptHex: protocolScript, vaultScriptHex: `5120${"f".repeat(64)}` };
const sellerFunding = { txid: listing.sellerAnchorTxid, vout: 0,
  valueSats: 10_000, scriptHex: sellerScript,
  tokenAtoms: listing.amountAtoms, tokenDeploymentTxid: deployTxid };
const buyerFunding = { txid: "1".repeat(64), vout: 0, valueSats: 10_000,
  scriptHex: buyerScript, tokenAtoms: 0n };
const terms = { listing, asset, sellerFunding, buyerFunding: [buyerFunding],
  buyerScriptHex: buyerScript, protocolScriptHex: protocolScript,
  recipientSats: 1_000, minerFeeSats: 400, currentHeight: 100n };

describe("browser market verifier and server writer", () => {
  it("share exact authorization messages and accept the same valid fill", () => {
    expect(crcListingMessage(listing)).toBe(serverListing(listing));
    expect(crcCancelMessage(listing)).toBe(serverCancel(listing));
    expect(crcMarketFee(5_000, 750n)).toBe(serverFee(5_000, 750n));
    const fill = createCrcFill(terms).psbt;
    expect(() => serverVerify(fill, terms)).not.toThrow();
    expect(() => verifyCrcFillTransaction(fill, terms)).not.toThrow();
  });

  it("browser reviewer refuses a changed payout, outpoint, fee recipient and metadata", () => {
    const fill = createCrcFill(terms).psbt;
    expect(() => verifyCrcFillTransaction(fill, { ...terms,
      listing: { ...listing, priceSats: 5_001 } })).toThrow();
    expect(() => verifyCrcFillTransaction(fill, { ...terms,
      asset: { ...asset, tokenOutpoint: `${"2".repeat(64)}:0` } })).toThrow();
    expect(() => verifyCrcFillTransaction(fill, { ...terms,
      asset: { ...asset, protocolScriptHex: buyerScript } })).toThrow();
    const altered = fill.clone();
    altered.data.inputs[1]!.sighashType = 0x83;
    expect(() => verifyCrcFillTransaction(altered, terms)).toThrow("trusted inputs");
  });

  it("matches server-created split-address fills and rejects a changed recipient", () => {
    const ordinalsScript = `5120${"9".repeat(64)}`;
    const split = { ...terms, buyerScriptHex: ordinalsScript,
      buyerFundingScriptHex: buyerScript };
    const fill = createCrcFill(split).psbt;
    expect(() => serverVerify(fill, split)).not.toThrow();
    expect(() => verifyCrcFillTransaction(fill, split)).not.toThrow();
    expect(() => verifyCrcFillTransaction(fill, { ...split,
      buyerScriptHex: `5120${"8".repeat(64)}` })).toThrow();
  });

  it("matches server-created nested SegWit buyer funding and rejects altered redeem metadata", () => {
    const buyerKey = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 0x44));
    const nestedScript = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({ pubkey: buyerKey.publicKey }),
    }).output!.toString("hex");
    const nested = { ...terms, buyerScriptHex: `5120${"9".repeat(64)}`,
      buyerFundingScriptHex: nestedScript, buyerFunding: [{ ...buyerFunding,
        scriptHex: nestedScript, publicKeyHex: buyerKey.publicKey.toString("hex") }] };
    const fill = createCrcFill(nested).psbt;
    expect(() => serverVerify(fill, nested)).not.toThrow();
    expect(() => verifyCrcFillTransaction(fill, nested)).not.toThrow();
    const altered = fill.clone();
    delete altered.data.inputs[1]!.redeemScript;
    expect(() => verifyCrcFillTransaction(altered, nested)).toThrow("trusted inputs");
  });
});
