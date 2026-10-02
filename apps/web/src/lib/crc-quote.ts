import * as core from "@crclaunch/crc20-protocol";
export type CrcQuoteAsset = {
  assetId: string;
  mintedAtoms: string;
  inventoryAtoms: string;
  circulatingAtoms: string;
  vaultAnchorSats: string;
  availability: "active" | "unavailable";
  vault: { txid: string; vout: number; btcSats: string };
  coreState: core.ProtocolDto<core.Asset>;
};
export class CrcQuoteError extends Error {
  constructor(
    readonly code: "ASSET_UNAVAILABLE" | "INVALID_STATE" | "TOKEN_AMOUNT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "CrcQuoteError";
  }
}
export function crcCoreAssetFromQuote(asset: CrcQuoteAsset): core.Asset {
  if (asset.availability !== "active")
    throw new CrcQuoteError("ASSET_UNAVAILABLE", "Cove CRC vault is unavailable");
  try {
    const state = core.decodeProtocolDto<core.Asset>(asset.coreState);
    core.validateAssetVault(state);
    const [network, deployId] = asset.assetId.split(":");
    if (
      !network ||
      core.protocolNetwork(network) !== state.config.network ||
      deployId !== state.deployTxid
    )
      throw new Error("CRC asset identity mismatch");
    return state;
  } catch (error) {
    throw new CrcQuoteError(
      "INVALID_STATE",
      error instanceof Error ? error.message : "CRC state unavailable",
    );
  }
}
function amountQuote<T>(quote: () => T): T {
  try {
    return quote();
  } catch (error) {
    throw new CrcQuoteError(
      "TOKEN_AMOUNT_INVALID",
      error instanceof Error ? error.message : "Invalid amount",
    );
  }
}
function checkedAmount(amount: bigint) {
  try {
    core.curveAmount(amount);
  } catch (error) {
    throw new CrcQuoteError(
      "TOKEN_AMOUNT_INVALID",
      error instanceof Error ? error.message : "Invalid amount",
    );
  }
}
export function quoteCrcBuy(asset: CrcQuoteAsset, amountAtoms: bigint) {
  const state = crcCoreAssetFromQuote(asset);
  checkedAmount(amountAtoms);
  const quote = amountQuote(() => core.quoteBuy(state, amountAtoms));
  return {
    assetId: asset.assetId,
    vaultOutpoint: core.outpoint(state.vault),
    operation: state.inventoryAtoms ? "transfer" : "mint",
    amountAtoms: amountAtoms.toString(),
    grossSats: quote.grossSats.toString(),
    protocolFeeSats: quote.protocolFeeSats.toString(),
    creatorFeeSats: quote.creatorFeeSats.toString(),
    buyerTotalSats: (quote.grossSats + quote.protocolFeeSats + quote.creatorFeeSats).toString(),
    minerFeeExcluded: true,
  };
}
export function quoteCrcSell(asset: CrcQuoteAsset, amountAtoms: bigint, payoutScriptHex: string) {
  const state = crcCoreAssetFromQuote(asset);
  checkedAmount(amountAtoms);
  core.requireSupportedOutputScript(payoutScriptHex);
  const quote = amountQuote(() => core.quoteSell(state, amountAtoms));
  return {
    assetId: asset.assetId,
    vaultOutpoint: core.outpoint(state.vault),
    operation: "transfer",
    amountAtoms: amountAtoms.toString(),
    grossSats: quote.grossSats.toString(),
    protocolFeeSats: quote.protocolFeeSats.toString(),
    sellerPayoutSats: quote.sellerPayoutSats.toString(),
    walletTopUpSats: quote.walletTopUpSats.toString(),
    sellerNetSats: quote.economicSats.toString(),
    payoutDustSats: core.carrierSats.toString(),
    minerFeeExcluded: true,
    walletTopUpExcludesCarrierCredits: true,
  };
}
