import { submitCrcFromBrowser } from "./crc-client-broadcast";
import { crcWalletData } from "./crc-wallet-data";
import * as core from "@crclaunch/crc20-protocol";
import {
  crcBrowserData,
  crcBrowserScript,
  signCrcBuildSession,
  type CrcBrowserBuild,
  type CrcBrowserWallet,
  type CrcRequest,
} from "./crc-browser-session";

/** Display fields project signed terms; they never authorize a transaction. */
export type CrcMarketListing = {
  id: string;
  network: string;
  deployTxid: string;
  ticker: string;
  status: string;
  sellerScriptHex: string;
  sellerPayoutScriptHex: string;
  sellerAnchorTxid: string;
  sellerAnchorVout: number;
  sellerAnchorSats: number;
  amountAtoms: string;
  expiresAtHeight: string;
  priceSats: number;
  protocolFeeSats: number;
  coreOffer: core.ProtocolDto<core.Offer>;
};
/** Ownership label only; purchases/cancellations still validate the full core offer. */
export function isCrcMarketListingOwner(
  row: CrcMarketListing,
  wallet: { network: string; script: string; ordinalsScript: string },
): boolean {
  if (core.protocolNetwork(row.network) !== core.protocolNetwork(wallet.network)) return false;
  const terms = row.coreOffer.escrowTerms;
  return terms
    ? terms.sellerTokenScriptHex === wallet.ordinalsScript &&
        terms.sellerAuthorityScriptHex === wallet.script
    : row.sellerScriptHex === wallet.ordinalsScript;
}
export function crcOfferFromListing(row: CrcMarketListing): core.Offer {
  const offer = core.decodeProtocolDto<core.Offer>(row.coreOffer);
  core.verifyOffer(offer);
  if (
    row.id !== core.offerId(offer) ||
    core.protocolNetwork(row.network) !== offer.network ||
    row.deployTxid !== offer.deployTxid ||
    row.ticker !== offer.ticker ||
    row.sellerScriptHex !== offer.sellerScriptHex ||
    row.sellerPayoutScriptHex !== offer.sellerScriptHex ||
    row.sellerAnchorTxid !== offer.listedInput.txid ||
    row.sellerAnchorVout !== offer.listedInput.vout ||
    String(row.sellerAnchorSats) !== core.sats(offer.listedInput.sats).toString() ||
    row.amountAtoms !== offer.listedInput.atoms.toString() ||
    String(row.priceSats) !== offer.priceSats.toString() ||
    String(row.protocolFeeSats) !== core.marketFee(offer.priceSats).toString() ||
    row.expiresAtHeight !== String(offer.expiryHeight) ||
    row.status !== "OPEN"
  )
    throw new Error("Listing display differs from signed core offer");
  return offer;
}
export async function buyCrcMarketListing(
  row: CrcMarketListing,
  wallet: CrcBrowserWallet & {
    script: string;
    ordinalsScript: string;
    signPsbt: (psbtBase64: string, operation: string) => Promise<string>;
  },
  minerFeeSats: number,
  request: CrcRequest = fetch,
): Promise<{ fillId: string; txid: string }> {
  const offer = crcOfferFromListing(row);
  if (
    core.protocolNetwork(wallet.network) !== offer.network ||
    crcBrowserScript(wallet.address, wallet.network) !== wallet.script ||
    crcBrowserScript(wallet.ordinalsAddress, wallet.network) !== wallet.ordinalsScript
  )
    throw new Error("Wallet network or address differs from this marketplace");
  if (isCrcMarketListingOwner(row, wallet))
    throw new Error("This is your listing. Manage or cancel it under Your listings.");
  if (
    !Number.isSafeInteger(minerFeeSats) ||
    minerFeeSats < 1 ||
    BigInt(minerFeeSats) > core.maxMinerFeeSats
  )
    throw new Error("Miner fee outside core policy");
  const { funding: paymentFunding, fundingEvidence } = await crcMarketFunding(request, wallet);
  const built = await crcBrowserData<CrcBrowserBuild & { fillId: string }>(
    request,
    "/api/crc/v1/market/reserve",
    {
      offerId: row.id,
      walletScriptHex: wallet.script,
      tokenScriptHex: wallet.ordinalsScript,
      walletPublicKeyHex: wallet.publicKey,
      tokenPublicKeyHex: wallet.ordinalsPublicKey || wallet.publicKey,
      paymentFunding,
      fundingEvidence,
      minerFeeSats,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  if (built.fillId !== built.sessionId) throw new Error("Market session identity changed");
  const sign = () =>
    signCrcBuildSession(
      built,
      {
        operation: "purchase",
        assetId: `${wallet.network}:${offer.deployTxid}`,
        amountAtoms: offer.listedInput.atoms.toString(),
        minerFeeSats,
        offer,
      },
      wallet,
      wallet.signPsbt,
      request,
    );
  const result = await submitCrcFromBrowser(
    built,
    wallet,
    "/api/crc/v1/market/buyer-sign",
    sign,
    request,
  );
  if (result.fillId !== built.sessionId || !/^[0-9a-f]{64}$/.test(result.txid))
    throw new Error("Market broadcast identity changed");
  return { txid: result.txid, fillId: result.fillId! };
}

async function crcMarketFunding(request: CrcRequest, wallet: CrcBrowserWallet) {
  const data = crcWalletData(wallet.network, request);
  const coins = await data.coins(wallet.address);
  const candidates = coins
    .filter((coin) => (coin.confirmations ?? 0) > 0)
    .slice(0, 40)
    .map(({ txid, vout }) => ({ txid, vout }));
  if (!candidates.length) throw new Error("Not enough confirmed Bitcoin for this sale");
  const checked = await crcBrowserData<{ tokenFreeOutpoints: { txid: string; vout: number }[] }>(
    request,
    "/api/crc/v1/market/funding-check",
    { outpoints: candidates },
  );
  const allowed = new Set(checked.tokenFreeOutpoints.map(core.outpoint));
  return data.funding(
    wallet.address,
    candidates.filter((coin) => allowed.has(core.outpoint(coin))),
    [wallet.address, wallet.ordinalsAddress],
  );
}

export async function cancelCrcMarketListing(
  row: CrcMarketListing,
  wallet: CrcBrowserWallet & {
    script: string;
    ordinalsScript: string;
    signPsbt: (psbtBase64: string, operation: string) => Promise<string>;
  },
  minerFeeSats: number,
  request: CrcRequest = fetch,
): Promise<{ txid: string }> {
  const offer = crcOfferFromListing(row);
  if (
    core.protocolNetwork(wallet.network) !== offer.network ||
    (offer.escrowTerms
      ? offer.escrowTerms.sellerTokenScriptHex !== wallet.ordinalsScript ||
        offer.escrowTerms.sellerAuthorityScriptHex !== wallet.script
      : offer.sellerScriptHex !== wallet.ordinalsScript) ||
    crcBrowserScript(wallet.address, wallet.network) !== wallet.script ||
    crcBrowserScript(wallet.ordinalsAddress, wallet.network) !== wallet.ordinalsScript
  )
    throw new Error("Listing belongs to another wallet or network");
  if (
    !Number.isSafeInteger(minerFeeSats) ||
    minerFeeSats < 1 ||
    BigInt(minerFeeSats) > core.maxMinerFeeSats
  )
    throw new Error("Miner fee outside core policy");
  const { funding: paymentFunding, fundingEvidence } = await crcMarketFunding(request, wallet);
  const built = await crcBrowserData<CrcBrowserBuild>(request, "/api/crc/v1/market/cancel-build", {
    offerId: row.id,
    walletScriptHex: wallet.script,
    tokenScriptHex: wallet.ordinalsScript,
    walletPublicKeyHex: wallet.publicKey,
    tokenPublicKeyHex: wallet.ordinalsPublicKey || wallet.publicKey,
    paymentFunding,
    fundingEvidence,
    minerFeeSats,
    idempotencyKey: crypto.randomUUID(),
  });
  const sign = () =>
    signCrcBuildSession(
      built,
      {
        operation: "cancel",
        offer,
        assetId: `${wallet.network}:${offer.deployTxid}`,
        amountAtoms: offer.listedInput.atoms.toString(),
        minerFeeSats,
      },
      wallet,
      wallet.signPsbt,
      request,
    );
  const result = await submitCrcFromBrowser(
    built,
    wallet,
    "/api/crc/v1/market/cancel",
    sign,
    request,
  );
  if (!/^[0-9a-f]{64}$/.test(result.txid))
    throw new Error("Cancellation broadcast identity changed");
  return result;
}
