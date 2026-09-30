import { describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { buildCoveV2MarketFill, buildUnsignedPsbt } from "@crclaunch/crc20-transactions";
import { crcListingMessage } from "@crclaunch/cove-market";
import { makeCrcSellerListing, sellerFillTermsFromPsbt, signCrcSellerFillAfterReview } from "./crc-market-seller";

const deployTxid = "a".repeat(64);
const sellerScriptHex = `0014${"b".repeat(40)}`;
const buyerScriptHex = `0014${"c".repeat(40)}`;
const buyerPaymentScriptHex = `0014${"9".repeat(40)}`;
const protocolScriptHex = `0014${"d".repeat(40)}`;
const vaultScriptHex = `5120${"a".repeat(64)}`;
const sellerFunding = { txid: "e".repeat(64), vout: 0, valueSats: 10_000,
  scriptHex: sellerScriptHex, tokenAtoms: 100n, tokenDeploymentTxid: deployTxid };
const buyerFunding = { txid: "f".repeat(64), vout: 0, valueSats: 10_000,
  scriptHex: buyerScriptHex, tokenAtoms: 0n };
const listing = { id: "11111111-1111-4111-8111-111111111111", network: "regtest" as const,
  deployTxid, ticker: "COVE", sellerScriptHex, sellerPayoutScriptHex: sellerScriptHex,
  sellerAnchorTxid: sellerFunding.txid, sellerAnchorVout: 0, sellerAnchorSats: 10_000,
  amountAtoms: 100n, priceSats: 5_000, protocolFeeSats: 1_000, expiresAtHeight: 200n };
const asset = { network: "regtest" as const, deployTxid, ticker: "COVE",
  protocolVersion: 2, tokenOutpoint: `${sellerFunding.txid}:0`, tokenScriptHex: sellerScriptHex,
  tokenAtoms: 100n, protocolScriptHex, vaultScriptHex };

function psbt(priceSats = 5_000, sighash = bitcoin.Transaction.SIGHASH_ALL,
  funding = buyerFunding) {
  const template = buildCoveV2MarketFill({ ticker: "COVE", deploymentTxid: deployTxid,
    listedInput: sellerFunding, buyerScriptHex, recipientSats: 1_000,
    sellerNetPriceSats: priceSats, protocolScriptHex, protocolFeeSats: 1_000,
    buyerChangeSats: 10_000 - priceSats - 1_000 - 1_000 - 400,
    buyerChangeScriptHex: funding.scriptHex });
  const built = buildUnsignedPsbt(template, [sellerFunding, funding], 400, bitcoin.networks.regtest);
  built.data.inputs[0]!.sighashType = sighash;
  return built.toBase64();
}

describe("CRC seller authorization", () => {
  it("binds a whole indexed token coin, exact payout and block expiry to BIP322", () => {
    const result = makeCrcSellerListing({ id: listing.id, network: "regtest", deployTxid,
      ticker: "COVE", sellerScriptHex, sellerPayoutScriptHex: sellerScriptHex,
      tokenCoin: { txid: sellerFunding.txid, vout: 0, atoms: "100", scriptHex: sellerScriptHex },
      bitcoinCoin: { txid: sellerFunding.txid, vout: 0, valueSats: "10000" },
      priceSats: 5_000, expiresAtHeight: 200n, currentHeight: 100n,
      asset: { ...asset, tokenAtoms: 100n } }, 750n, 1_000n);
    expect(result).toEqual(listing);
    expect(crcListingMessage(result)).toContain('"sellerAnchorTxid":"' + sellerFunding.txid + '"');
  });

  it("rejects wrong wallet, missing carrier, expiry and non-v2 token before authorization", () => {
    const options = { id: listing.id, network: "regtest" as const, deployTxid,
      ticker: "COVE", sellerScriptHex, sellerPayoutScriptHex: sellerScriptHex,
      tokenCoin: { txid: sellerFunding.txid, vout: 0, atoms: "100", scriptHex: sellerScriptHex },
      bitcoinCoin: { txid: sellerFunding.txid, vout: 0, valueSats: "10000" },
      priceSats: 5_000, expiresAtHeight: 200n, currentHeight: 100n, asset };
    expect(() => makeCrcSellerListing({ ...options, sellerScriptHex: buyerScriptHex }, 750n, 1_000n)).toThrow();
    expect(() => makeCrcSellerListing({ ...options, bitcoinCoin: null }, 750n, 1_000n)).toThrow();
    expect(() => makeCrcSellerListing({ ...options, expiresAtHeight: 100n }, 750n, 1_000n)).toThrow();
    expect(() => makeCrcSellerListing({ ...options, asset: { ...asset, protocolVersion: 1 } }, 750n, 1_000n)).toThrow();
  });

  it("verifies full transaction and SIGHASH_ALL before opening seller wallet", async () => {
    const signer = vi.fn(async () => "signed");
    const terms = { listing, asset, sellerFunding, buyerFunding: [buyerFunding], buyerScriptHex,
      protocolScriptHex, recipientSats: 1_000, minerFeeSats: 400, currentHeight: 100n };
    await expect(signCrcSellerFillAfterReview(psbt(), terms, sellerScriptHex, signer)).resolves.toBe("signed");
    expect(signer).toHaveBeenCalledOnce();
    signer.mockClear();
    await expect(signCrcSellerFillAfterReview(psbt(5_001), terms, sellerScriptHex, signer)).rejects.toThrow();
    await expect(signCrcSellerFillAfterReview(psbt(), terms, buyerScriptHex, signer)).rejects.toThrow();
    await expect(signCrcSellerFillAfterReview(psbt(5_000, 0x83), terms, sellerScriptHex, signer)).rejects.toThrow();
    expect(signer).not.toHaveBeenCalled();
  });

  it("reconstructs terms from the PSBT and rejects changed payout, fee, and token authority", () => {
    const terms = sellerFillTermsFromPsbt(psbt(), listing, asset, 100n);
    expect(terms.sellerFunding.txid).toBe(sellerFunding.txid);
    expect(terms.buyerScriptHex).toBe(buyerScriptHex);
    expect(terms.minerFeeSats).toBe(400);
    expect(() => sellerFillTermsFromPsbt(psbt(5_001), listing, asset, 100n)).toThrow();
    expect(() => sellerFillTermsFromPsbt(psbt(5_000, 0x83), listing, asset, 100n)).toThrow();
    expect(() => sellerFillTermsFromPsbt(psbt(), listing,
      { ...asset, tokenOutpoint: `${"1".repeat(64)}:0` }, 100n)).toThrow();
    expect(() => sellerFillTermsFromPsbt(psbt(), { ...listing, protocolFeeSats: 1_001 }, asset, 100n)).toThrow();
  });

  it("reviews Xverse payment funding separately from the token recipient", () => {
    const funding = { ...buyerFunding, scriptHex: buyerPaymentScriptHex };
    const terms = sellerFillTermsFromPsbt(psbt(5_000, bitcoin.Transaction.SIGHASH_ALL, funding),
      listing, asset, 100n);
    expect(terms.buyerScriptHex).toBe(buyerScriptHex);
    expect(terms.buyerFundingScriptHex).toBe(buyerPaymentScriptHex);
    expect(terms.buyerFunding[0]?.scriptHex).toBe(buyerPaymentScriptHex);
  });
});
