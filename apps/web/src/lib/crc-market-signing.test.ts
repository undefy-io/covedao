import { describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { buildCoveV3MarketFill, buildUnsignedPsbt } from "@crclaunch/crc20-transactions";
import { signCrcMarketFillAfterReview } from "./crc-market-signing";

const deploymentTxid = "a".repeat(64);
const sellerScriptHex = `0014${"b".repeat(40)}`;
const buyerScriptHex = `0014${"c".repeat(40)}`;
const protocolScriptHex = `0014${"d".repeat(40)}`;
const vaultScriptHex = `5120${"a".repeat(64)}`;
const sellerFunding = { txid: "e".repeat(64), vout: 0, valueSats: 10_000,
  scriptHex: sellerScriptHex, tokenAtoms: 100n, tokenDeploymentTxid: deploymentTxid };
const buyerFunding = { txid: "f".repeat(64), vout: 0, valueSats: 10_000,
  scriptHex: buyerScriptHex, tokenAtoms: 0n };
const listing = { id: "11111111-1111-4111-8111-111111111111", network: "regtest" as const,
  deployTxid: deploymentTxid, ticker: "COVE", sellerScriptHex, sellerPayoutScriptHex: sellerScriptHex,
  sellerAnchorTxid: sellerFunding.txid, sellerAnchorVout: 0, sellerAnchorSats: 10_000,
  amountAtoms: 100n, priceSats: 5_000, protocolFeeSats: 1_000, expiresAtHeight: 200n };
const asset = { network: "regtest" as const, deployTxid: deploymentTxid, ticker: "COVE",
  protocolVersion: 3, tokenOutpoint: `${sellerFunding.txid}:0`, tokenScriptHex: sellerScriptHex,
  tokenAtoms: 100n, protocolScriptHex, vaultScriptHex };
const terms = { listing, asset, sellerFunding, buyerFunding: [buyerFunding], buyerScriptHex,
  protocolScriptHex, recipientSats: 1_000, minerFeeSats: 400, currentHeight: 100n };

function psbt(price = 5_000): string {
  const template = buildCoveV3MarketFill({ ticker: "COVE", deploymentTxid, listedInput: sellerFunding,
    buyerScriptHex, recipientSats: 1_000, sellerNetPriceSats: price,
    protocolScriptHex, protocolFeeSats: 1_000, buyerChangeSats: 10_000 - price - 1_000 - 1_000 - 400 });
  const built = buildUnsignedPsbt(template, [sellerFunding, buyerFunding], 400, bitcoin.networks.regtest);
  built.data.inputs[0]!.sighashType = bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY;
  return built.toBase64();
}

describe("CRC buyer signing boundary", () => {
  it("reviews exact v3 payment and marker before opening the wallet signer", async () => {
    const signer = vi.fn(async () => "signed");
    await expect(signCrcMarketFillAfterReview(psbt(), terms, buyerScriptHex, signer)).resolves.toBe("signed");
    expect(signer).toHaveBeenCalledOnce();
  });

  it("does not open the signer for a changed payout, wallet, or token outpoint", async () => {
    const signer = vi.fn(async () => "signed");
    await expect(signCrcMarketFillAfterReview(psbt(5_001), terms, buyerScriptHex, signer)).rejects.toThrow();
    await expect(signCrcMarketFillAfterReview(psbt(), terms, sellerScriptHex, signer)).rejects.toThrow();
    await expect(signCrcMarketFillAfterReview(psbt(), { ...terms,
      asset: { ...asset, tokenOutpoint: `${"1".repeat(64)}:0` } }, buyerScriptHex, signer)).rejects.toThrow();
    await expect(signCrcMarketFillAfterReview(psbt(), { ...terms,
      listing: { ...listing, protocolFeeSats: 1_001 } }, buyerScriptHex, signer)).rejects.toThrow();
    await expect(signCrcMarketFillAfterReview(psbt(), { ...terms,
      recipientSats: 1_001 }, buyerScriptHex, signer)).rejects.toThrow();
    await expect(signCrcMarketFillAfterReview(psbt(), { ...terms,
      minerFeeSats: 401 }, buyerScriptHex, signer)).rejects.toThrow();
    await expect(signCrcMarketFillAfterReview(psbt(), { ...terms,
      asset: { ...asset, protocolScriptHex: buyerScriptHex } }, buyerScriptHex, signer)).rejects.toThrow();
    await expect(signCrcMarketFillAfterReview(psbt(), { ...terms,
      asset: { ...asset, vaultScriptHex: buyerScriptHex } }, buyerScriptHex, signer)).rejects.toThrow();
    expect(signer).not.toHaveBeenCalled();
  });
});
