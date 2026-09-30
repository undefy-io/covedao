import * as bitcoin from "bitcoinjs-lib";
import type { CoveV2Input } from "@crclaunch/crc20-transactions";
import { addressToScript } from "./address";
import { bigintField, fail, handleError, ok, readJson, strField } from "./api";
import { buildCrcTradeSession } from "./crc-build";
import { getCrcMutationServices } from "./crc-mutation";
import { checkCrcRateLimit } from "./crc-rate-limit";
import { parseCrcAssetId, readCrcBalance, readCrcCursor, readCrcQuoteAsset, readCrcTokenUtxo } from "./crc-read";
import { normalizeCrcWalletPublicKey } from "./crc-wallet-key";

export async function crcTradeBuildRoute(req: Request, operation: "buy" | "sell"): Promise<Response> {
  try {
    const limited = checkCrcRateLimit(req, true);
    if (limited) return limited;
    const { db, config, crcVaultConfig, provider } = getCrcMutationServices();
    const body = await readJson(req);
    const identity = parseCrcAssetId(strField(body, "assetId"), config.network);
    if (!identity) return fail("TOKEN_NOT_FOUND", "Token not found", 404);
    const amountAtoms = bigintField(body, "amountAtoms", 0n);
    if (amountAtoms <= 0n || amountAtoms % 100_000_000n !== 0n) return fail("TOKEN_AMOUNT_INVALID", "Enter a positive whole number of tokens", 400);
    const indexedTip = await readCrcCursor(db, config.network);
    if (!indexedTip) return fail("INDEXER_REBUILDING", "Cove CRC index is not ready", 503, true);
    const asset = await readCrcQuoteAsset(db, config.network, identity.deployTxid);
    if (!asset || asset.availability !== "active") return fail("ASSET_UNAVAILABLE", "Trusted CRC vault is unavailable", 503, true);
    if (asset.protocolVersion !== 2) return fail("CRC_V1_READ_ONLY", "This legacy token is read-only; launch a new Cove v2 token to trade", 409);
    const walletScriptHex = addressToScript(strField(body, "walletAddress"), config.network);
    const tokenScriptHex = addressToScript(strField(body, "ordinalsAddress") || strField(body, "walletAddress"), config.network);
    if (operation === "sell" && amountAtoms > await readCrcBalance(db, config.network, identity.deployTxid, tokenScriptHex)) {
      return fail("INSUFFICIENT_BALANCE", "Sell amount exceeds indexed wallet balance", 400);
    }
    const minerFeeSats = bigintField(body, "minerFeeSats", 0n);
    if (minerFeeSats < 1n || minerFeeSats > config.maxMinerFeeSats || minerFeeSats > 20_000n) {
      return fail("MINER_FEE_TOO_HIGH", "Choose a miner fee from 1 to 20,000 sats", 400);
    }
    const paymentFunding = body.paymentFunding;
    if (!Array.isArray(paymentFunding)) return fail("FUNDING_INPUT_INVALID", "Payment funding candidates are required", 400);
    const sellerFunding = body.sellerFunding;
    if (operation === "sell" && (!Array.isArray(sellerFunding) || sellerFunding.length < 1 || sellerFunding.length > 32)) {
      return fail("FUNDING_INPUT_INVALID", "One to 32 indexed token inputs are required", 400);
    }
    const idempotencyKey = strField(body, "idempotencyKey");
    if (!idempotencyKey || idempotencyKey.length > 128) return fail("BAD_REQUEST", "Idempotency key is required", 400);
    const bitcoinNetwork = config.network === "mainnet" ? bitcoin.networks.bitcoin
      : config.network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
    const verifiedSellerInputs: CoveV2Input[] = [];
    if (operation === "sell") {
      const seen = new Set<string>();
      for (const seller of sellerFunding as { txid?: unknown; vout?: unknown }[]) {
        if (typeof seller.txid !== "string" || !/^[0-9a-f]{64}$/.test(seller.txid) ||
          !Number.isSafeInteger(seller.vout) || (seller.vout as number) < 0 ||
          seen.has(`${seller.txid}:${seller.vout}`)) {
          return fail("FUNDING_INPUT_INVALID", "Invalid or duplicate token outpoint", 400);
        }
        seen.add(`${seller.txid}:${seller.vout}`);
        const coin = await readCrcTokenUtxo(db, config.network, identity.deployTxid, seller.txid, seller.vout as number);
        if (!coin || coin.scriptHex !== tokenScriptHex || coin.atoms <= 0n) {
          return fail("TOKEN_OUTPOINT_INVALID", "Selected output has no indexed token allocation", 400);
        }
        const observed = await provider.getTxout(seller.txid, seller.vout as number);
        if (!observed || observed.confirmations < 1 || observed.scriptPubKeyHex.toLowerCase() !== tokenScriptHex ||
          observed.valueSats <= 0n || observed.valueSats > BigInt(Number.MAX_SAFE_INTEGER)) {
          return fail("FUNDING_INPUT_SPENT", "Token output is not a confirmed wallet output", 400);
        }
        verifiedSellerInputs.push({
          txid: seller.txid, vout: seller.vout as number,
          valueSats: Number(observed.valueSats), scriptHex: tokenScriptHex,
          tokenAtoms: coin.atoms, tokenDeploymentTxid: identity.deployTxid,
          ...(strField(body, "ordinalsPublicKey") ? {
            publicKeyHex: normalizeCrcWalletPublicKey(tokenScriptHex, strField(body, "ordinalsPublicKey")),
          } : {}),
        });
      }
      if (verifiedSellerInputs.reduce((sum, input) => sum + input.tokenAtoms, 0n) < amountAtoms) {
        return fail("INSUFFICIENT_BALANCE", "Selected token outputs do not cover this sale", 400);
      }
    }
    const built = await buildCrcTradeSession({
      db, network: config.network, bitcoinNetwork, asset: { ...asset, protocolVersion: 2, network: config.network }, operation, amountAtoms,
      walletScriptHex, tokenScriptHex,
      walletPublicKeyHex: normalizeCrcWalletPublicKey(walletScriptHex, strField(body, "walletPublicKey") || undefined),
      tokenPublicKeyHex: normalizeCrcWalletPublicKey(tokenScriptHex, strField(body, "ordinalsPublicKey") || undefined),
      sellerFunding: operation === "sell" ? sellerFunding as { txid: string; vout: number }[] : undefined,
      verifiedSellerInputs,
      paymentFunding: paymentFunding as { txid: string; vout: number }[],
      minerFeeSats: Number(minerFeeSats), idempotencyKey,
      feeScriptHex: crcVaultConfig.feeScriptHex,
    });
    return ok({ ...built, indexedTip });
  } catch (error) {
    return handleError(error);
  }
}
