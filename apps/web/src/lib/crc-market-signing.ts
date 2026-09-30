import * as bitcoin from "bitcoinjs-lib";
import { verifyCrcFillTransaction, type CrcFillOptions } from "@crclaunch/cove-market";

export async function signCrcMarketFillAfterReview(
  psbtBase64: string,
  terms: CrcFillOptions,
  walletScriptHex: string,
  signPsbt: (psbtBase64: string, operation: string) => Promise<string>,
): Promise<string> {
  if (terms.buyerScriptHex.toLowerCase() !== walletScriptHex.toLowerCase()) {
    throw new Error("market fill buyer does not match connected wallet");
  }
  const network = terms.listing.network === "mainnet" ? bitcoin.networks.bitcoin :
    terms.listing.network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });
  verifyCrcFillTransaction(psbt, terms);
  return signPsbt(psbtBase64, "CRC_MARKET_BUY");
}
