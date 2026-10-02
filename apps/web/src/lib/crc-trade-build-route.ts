import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { readCrcBuildFeeRate } from "./crc-build-fee";
import { parseCrcFundingOutpoints } from "./crc-funding";
import { addressToScript } from "./address";
import { bigintField, fail, handleError, ok, readJson, strField } from "./api";
import { buildCrcTradeSession } from "./crc-build";
import { getCrcMutationServices } from "./crc-mutation";
import { checkCrcRateLimit } from "./crc-rate-limit";
import { parseCrcAssetId, readCrcCursor } from "./crc-read";
import { normalizeCrcWalletPublicKey } from "./crc-wallet-key";

export async function crcTradeBuildRoute(
  req: Request,
  operation: "buy" | "sell",
): Promise<Response> {
  try {
    const limited = checkCrcRateLimit(req, true);
    if (limited) return limited;
    const { db, config, crcVaultConfig } = getCrcMutationServices();
    const body = await readJson(req);
    const identity = parseCrcAssetId(strField(body, "assetId"), config.network);
    if (!identity) return fail("TOKEN_NOT_FOUND", "Token not found", 404);
    const amountAtoms = bigintField(body, "amountAtoms", 0n);
    try {
      core.curveAmount(amountAtoms);
    } catch (error) {
      return fail(
        "TOKEN_AMOUNT_INVALID",
        error instanceof Error ? error.message : "Invalid token amount",
        400,
      );
    }
    const indexedTip = await readCrcCursor(db, config.network);
    if (!indexedTip) return fail("INDEXER_REBUILDING", "Cove CRC index is not ready", 503, true);
    const walletScriptHex = addressToScript(strField(body, "walletAddress"), config.network);
    const tokenScriptHex = addressToScript(
      strField(body, "ordinalsAddress") || strField(body, "walletAddress"),
      config.network,
    );
    const feeTier = strField(body, "feeTier");
    if (feeTier !== "eco" && feeTier !== "standard" && feeTier !== "priority")
      return fail("BAD_REQUEST", "Choose a mining speed", 400);
    const idempotencyKey = strField(body, "idempotencyKey");
    if (!idempotencyKey || idempotencyKey.length > 128)
      return fail("BAD_REQUEST", "Idempotency key is required", 400);
    const rate = await readCrcBuildFeeRate(db, config.network, idempotencyKey, feeTier);
    const paymentFunding = parseCrcFundingOutpoints(body.paymentFunding);
    const sellerFunding =
      operation === "sell" ? parseCrcFundingOutpoints(body.sellerFunding, 32) : undefined;
    if (operation === "sell" && !sellerFunding?.length)
      return fail("FUNDING_INPUT_INVALID", "Select indexed token inputs", 400);
    const bitcoinNetwork =
      config.network === "mainnet"
        ? bitcoin.networks.bitcoin
        : config.network === "regtest"
          ? bitcoin.networks.regtest
          : bitcoin.networks.testnet;
    const built = await buildCrcTradeSession({
      db,
      network: config.network,
      bitcoinNetwork,
      asset: {
        assetId: `${config.network}:${identity.deployTxid}`,
        deployTxid: identity.deployTxid,
      },
      operation,
      amountAtoms,
      walletScriptHex,
      tokenScriptHex,
      walletPublicKeyHex: normalizeCrcWalletPublicKey(
        walletScriptHex,
        strField(body, "walletPublicKey") || undefined,
      ),
      tokenPublicKeyHex: normalizeCrcWalletPublicKey(
        tokenScriptHex,
        strField(body, "ordinalsPublicKey") || undefined,
      ),
      sellerFunding,
      paymentFunding,
      feeRateSatPerVb: Number(rate),
      feeTier,
      idempotencyKey,
      feeScriptHex: crcVaultConfig.feeScriptHex,
    });
    return ok({ ...built, indexedTip });
  } catch (error) {
    return handleError(error);
  }
}
