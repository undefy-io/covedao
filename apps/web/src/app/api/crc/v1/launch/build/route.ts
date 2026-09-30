import * as bitcoin from "bitcoinjs-lib";
import { addressToScript } from "@/lib/address";
import { bigintField, fail, handleError, ok, readJson, strField } from "@/lib/api";
import { buildCrcLaunchSession } from "@/lib/crc-build";
import { getCrcMutationServices } from "@/lib/crc-mutation";
import { checkCrcRateLimit } from "@/lib/crc-rate-limit";
import { normalizeCrcWalletPublicKey } from "@/lib/crc-wallet-key";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const limited = checkCrcRateLimit(req, true);
    if (limited) return limited;
    const { db, config, crcVaultConfig } = getCrcMutationServices();
    const body = await readJson(req);
    const walletAddress = strField(body, "walletAddress");
    const tokenAddress = strField(body, "ordinalsAddress") || walletAddress;
    const walletScriptHex = addressToScript(walletAddress, config.network);
    const tokenScriptHex = addressToScript(tokenAddress, config.network);
    if (strField(body, "walletScript") && strField(body, "walletScript").toLowerCase() !== walletScriptHex) {
      return fail("CLIENT_INTENT_MISMATCH", "Wallet address and script differ", 400);
    }
    const minerFee = bigintField(body, "minerFeeSats", 0n);
    if (minerFee < 1n || minerFee > config.maxMinerFeeSats) return fail("MINER_FEE_TOO_HIGH", "Choose a miner fee from 1 to 20,000 sats", 400);
    const funding = body.funding;
    if (!Array.isArray(funding)) return fail("FUNDING_INPUT_INVALID", "Wallet funding candidates are required", 400);
    const idempotencyKey = strField(body, "idempotencyKey");
    if (!idempotencyKey || idempotencyKey.length > 128) return fail("BAD_REQUEST", "Idempotency key is required", 400);
    const bitcoinNetwork = config.network === "mainnet" ? bitcoin.networks.bitcoin : config.network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
    const built = await buildCrcLaunchSession({
      db, network: config.network, bitcoinNetwork,
      ticker: strField(body, "ticker").toUpperCase(),
      walletScriptHex, tokenScriptHex,
      walletPublicKeyHex: normalizeCrcWalletPublicKey(walletScriptHex, strField(body, "walletPublicKey") || undefined),
      funding: funding as { txid: string; vout: number }[],
      minerFeeSats: Number(minerFee), idempotencyKey,
      feeScriptHex: crcVaultConfig.feeScriptHex,
      guardianXOnly: crcVaultConfig.guardianXOnly,
      recoveryProfile: crcVaultConfig.recoveryProfile,
    });
    return ok(built);
  } catch (error) {
    return handleError(error);
  }
}
