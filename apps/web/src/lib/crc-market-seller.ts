import * as core from "@crclaunch/crc20-protocol";
import { completeOfferSigning, prepareOfferSigning, type WalletAccount } from "@crclaunch/crc20-adapters";

/** Presentation of one core offer, retaining the existing review controls. */
export type CrcSellerListing = {
  id: string; network: string; deployTxid: string; ticker: string;
  sellerScriptHex: string; sellerPayoutScriptHex: string;
  sellerAnchorTxid: string; sellerAnchorVout: number; sellerAnchorSats: number;
  amountAtoms: bigint; priceSats: bigint; protocolFeeSats: bigint; expiresAtHeight: bigint;
  terms: core.OfferTerms;
};
export function makeCrcSellerListing(options: {
  network: string; coreState: unknown; sellerScriptHex: string; publicKeyHex: string;
  tokenCoin: { txid: string; vout: number; atoms: string; scriptHex: string };
  bitcoinCoin: { txid: string; vout: number; valueSats: string } | null;
  priceSats: bigint; currentHeight: number; expiryHeight: number;
}): CrcSellerListing {
  const state = core.decodeProtocolDto<core.Asset>(options.coreState);
  core.validateConfig(state.config);
  const coin = options.tokenCoin, bitcoin = options.bitcoinCoin;
  if (!bitcoin || bitcoin.txid !== coin.txid || bitcoin.vout !== coin.vout || options.sellerScriptHex !== coin.scriptHex ||
    state.config.network !== core.protocolNetwork(options.network) || !/^[1-9]\d*$/.test(coin.atoms) || !/^[1-9]\d*$/.test(bitcoin.valueSats) ||
    !Number.isSafeInteger(options.currentHeight) || options.currentHeight < 0 || options.expiryHeight <= options.currentHeight) throw new Error("Listing differs from indexed token output or current height");
  const terms: core.OfferTerms = { network: state.config.network, deployTxid: state.deployTxid, ticker: state.config.ticker,
    listedInput: { txid: coin.txid, vout: coin.vout, atoms: BigInt(coin.atoms), sats: BigInt(bitcoin.valueSats), scriptHex: coin.scriptHex, deployTxid: state.deployTxid },
    sellerScriptHex: options.sellerScriptHex, priceSats: options.priceSats, expiryHeight: options.expiryHeight,
    publicKeyHex: core.canonicalOfferPublicKey(options.publicKeyHex.toLowerCase(), coin.scriptHex) };
  core.validateOfferTerms(terms);
  return { id: core.offerId({ ...terms, signatureHex: "", sellerWitnessHex: [] }), network: options.network,
    deployTxid: terms.deployTxid, ticker: terms.ticker, sellerScriptHex: terms.sellerScriptHex, sellerPayoutScriptHex: terms.sellerScriptHex,
    sellerAnchorTxid: coin.txid, sellerAnchorVout: coin.vout, sellerAnchorSats: Number(core.sats(terms.listedInput.sats)),
    amountAtoms: terms.listedInput.atoms, priceSats: terms.priceSats, protocolFeeSats: core.marketFee(terms.priceSats), expiresAtHeight: BigInt(terms.expiryHeight), terms };
}
export async function signCrcSellerListing(
  listing: CrcSellerListing, account: WalletAccount,
  signPsbt: (psbtBase64: string, operation: string) => Promise<string>,
  signBip322: (message: string) => Promise<string>,
): Promise<core.Offer> {
  const prepared = prepareOfferSigning(listing.terms, account);
  const proof = await signBip322(core.offerMessage(listing.terms));
  const signed = await signPsbt(prepared.params.psbt, "P2P_LIST");
  return completeOfferSigning(prepared, proof, signed);
}
