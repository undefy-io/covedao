import { dustThreshold } from "@crclaunch/bitcoin";
import { CurveTransitionError, quoteBuy, quoteSell, requiredBacking, type CurveState } from "@crclaunch/crc20-curve";

const ATOMS_PER_TOKEN = 100_000_000n;

export type CrcQuoteAsset = {
  assetId: string;
  mintedAtoms: string;
  inventoryAtoms: string;
  circulatingAtoms: string;
  vaultAnchorSats: string;
  availability: "active" | "unavailable";
  vault: { txid: string; vout: number; btcSats: string };
};

export class CrcQuoteError extends Error {
  constructor(readonly code: "ASSET_UNAVAILABLE" | "INVALID_STATE" | "TOKEN_AMOUNT_INVALID", message: string) {
    super(message);
    this.name = "CrcQuoteError";
  }
}

export function crcCurveStateFromAsset(asset: CrcQuoteAsset): CurveState {
  if (asset.availability !== "active") throw new CrcQuoteError("ASSET_UNAVAILABLE", "Cove CRC vault is unavailable");
  const mintedAtoms = BigInt(asset.mintedAtoms);
  const vaultAtoms = BigInt(asset.inventoryAtoms);
  const circulatingAtoms = BigInt(asset.circulatingAtoms);
  const vaultSats = BigInt(asset.vault.btcSats);
  if (circulatingAtoms < 0n || circulatingAtoms % ATOMS_PER_TOKEN !== 0n) {
    throw new CrcQuoteError("INVALID_STATE", "Cove CRC supply is inconsistent");
  }
  let reserveSats: bigint;
  try {
    reserveSats = requiredBacking(circulatingAtoms / ATOMS_PER_TOKEN);
  } catch (error) {
    if (error instanceof CurveTransitionError) throw new CrcQuoteError("INVALID_STATE", "Cove CRC supply is inconsistent");
    throw error;
  }
  const vaultAnchorSats = BigInt(asset.vaultAnchorSats);
  if (vaultAnchorSats < 0n || vaultSats !== vaultAnchorSats + reserveSats) {
    throw new CrcQuoteError("INVALID_STATE", "Cove CRC backing does not match its registered anchor");
  }
  return {
    version: "cove-curve-v3",
    mintedAtoms,
    vaultAtoms,
    circulatingAtoms,
    vaultAnchorSats,
    vaultSats,
    vaultOutpoint: `${asset.vault.txid}:${asset.vault.vout}`,
  };
}

function tokensFromAtoms(amountAtoms: bigint): bigint {
  if (amountAtoms <= 0n || amountAtoms % ATOMS_PER_TOKEN !== 0n) {
    throw new CrcQuoteError("TOKEN_AMOUNT_INVALID", "Amount must be a positive whole number of tokens");
  }
  return amountAtoms / ATOMS_PER_TOKEN;
}

export function quoteCrcBuy(asset: CrcQuoteAsset, amountAtoms: bigint) {
  const state = crcCurveStateFromAsset(asset);
  const quote = quoteBuy(state, tokensFromAtoms(amountAtoms));
  return {
    assetId: asset.assetId,
    vaultOutpoint: state.vaultOutpoint,
    operation: quote.operation,
    amountAtoms: quote.amountAtoms.toString(),
    grossSats: quote.grossSats.toString(),
    protocolFeeSats: quote.protocolFeeSats.toString(),
    creatorFeeSats: quote.creatorFeeSats.toString(),
    buyerTotalSats: quote.buyerTotalSats.toString(),
    minerFeeExcluded: true,
  };
}

export function quoteCrcSell(asset: CrcQuoteAsset, amountAtoms: bigint, payoutScriptHex: string) {
  const state = crcCurveStateFromAsset(asset);
  const payoutDustSats = dustThreshold(Buffer.from(payoutScriptHex, "hex"));
  const quote = quoteSell(state, tokensFromAtoms(amountAtoms), payoutDustSats);
  return {
    assetId: asset.assetId,
    vaultOutpoint: state.vaultOutpoint,
    operation: quote.operation,
    amountAtoms: quote.amountAtoms.toString(),
    grossSats: quote.grossSats.toString(),
    protocolFeeSats: quote.protocolFeeSats.toString(),
    sellerPayoutSats: quote.sellerPayoutSats.toString(),
    walletTopUpSats: quote.walletTopUpSats.toString(),
    sellerNetSats: quote.sellerNetSats.toString(),
    payoutDustSats: payoutDustSats.toString(),
    minerFeeExcluded: true,
  };
}
