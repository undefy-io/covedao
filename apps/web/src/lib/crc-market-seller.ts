import * as bitcoin from "bitcoinjs-lib";
import {
  crcMarketFee, verifyCrcFillTransaction,
  type CrcFillOptions, type CrcListing, type CrcNetwork, type IndexedCrcAsset,
} from "@crclaunch/cove-market/crc20/browser";

type TokenCoin = { txid: string; vout: number; atoms: string; scriptHex: string };
type BitcoinCoin = { txid: string; vout: number; valueSats: string } | null;

export function makeCrcSellerListing(options: {
  id: string;
  network: CrcNetwork;
  deployTxid: string;
  ticker: string;
  sellerScriptHex: string;
  sellerPayoutScriptHex: string;
  tokenCoin: TokenCoin;
  bitcoinCoin: BitcoinCoin;
  priceSats: number;
  expiresAtHeight: bigint;
  currentHeight: bigint;
  asset: IndexedCrcAsset;
}, feeBps: bigint, feeMinSats: bigint): CrcListing {
  const { tokenCoin, bitcoinCoin } = options;
  if (!/^(0014[0-9a-f]{40}|5120[0-9a-f]{64})$/i.test(options.sellerScriptHex)) {
    throw new Error("Marketplace seller output must be native SegWit or Taproot");
  }
  if (!bitcoinCoin || bitcoinCoin.txid !== tokenCoin.txid || bitcoinCoin.vout !== tokenCoin.vout) {
    throw new Error("Selected token output has no matching Bitcoin output");
  }
  if (!/^[1-9]\d*$/.test(tokenCoin.atoms) || !/^[1-9]\d*$/.test(bitcoinCoin.valueSats)) {
    throw new Error("Selected token or Bitcoin amount is invalid");
  }
  const sellerAnchorSats = Number(bitcoinCoin.valueSats);
  if (!Number.isSafeInteger(sellerAnchorSats) || sellerAnchorSats <= 0) {
    throw new Error("Selected Bitcoin output value is invalid");
  }
  const listing: CrcListing = {
    id: options.id,
    network: options.network,
    deployTxid: options.deployTxid,
    ticker: options.ticker,
    sellerScriptHex: options.sellerScriptHex,
    sellerPayoutScriptHex: options.sellerPayoutScriptHex,
    sellerAnchorTxid: tokenCoin.txid,
    sellerAnchorVout: tokenCoin.vout,
    sellerAnchorSats,
    amountAtoms: BigInt(tokenCoin.atoms),
    priceSats: options.priceSats,
    protocolFeeSats: crcMarketFee(options.priceSats, feeBps, feeMinSats),
    expiresAtHeight: options.expiresAtHeight,
  };
  if (tokenCoin.scriptHex.toLowerCase() !== options.sellerScriptHex.toLowerCase()) {
    throw new Error("Selected token output does not belong to the connected wallet");
  }
  if (options.asset.protocolVersion !== 3 || options.asset.network !== listing.network ||
    options.asset.deployTxid !== listing.deployTxid || options.asset.ticker !== listing.ticker ||
    options.asset.tokenOutpoint !== `${listing.sellerAnchorTxid}:${listing.sellerAnchorVout}` ||
    options.asset.tokenAtoms !== listing.amountAtoms ||
    options.asset.tokenScriptHex?.toLowerCase() !== listing.sellerScriptHex.toLowerCase() ||
    options.asset.vaultScriptHex.toLowerCase() === listing.sellerScriptHex.toLowerCase() ||
    listing.sellerPayoutScriptHex.toLowerCase() !== listing.sellerScriptHex.toLowerCase() ||
    listing.expiresAtHeight <= options.currentHeight || !Number.isSafeInteger(listing.priceSats) ||
    listing.priceSats <= 0) {
    throw new Error("Listing does not match the current indexed Cove CRC token output");
  }
  return listing;
}

function networkParams(network: CrcNetwork): bitcoin.networks.Network {
  if (network === "mainnet") return bitcoin.networks.bitcoin;
  if (network === "regtest") return bitcoin.networks.regtest;
  return bitcoin.networks.testnet;
}

export function sellerFillTermsFromPsbt(
  psbtBase64: string,
  listing: CrcListing,
  asset: IndexedCrcAsset,
  currentHeight: bigint,
): CrcFillOptions {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: networkParams(listing.network) });
  const transaction = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  if (transaction.ins.length < 2 || transaction.outs.length < 4 || psbt.data.inputs.length !== transaction.ins.length) {
    throw new Error("Market fill has invalid inputs or outputs");
  }
  const funding = transaction.ins.map((input, index) => {
    const witness = psbt.data.inputs[index]?.witnessUtxo;
    if (!witness) throw new Error("Market fill is missing trusted Bitcoin input amounts");
    const scriptHex = witness.script.toString("hex");
    const p2sh = /^a914[0-9a-f]{40}87$/.test(scriptHex);
    const partialKey = psbt.data.inputs[index]?.partialSig?.find((signature) =>
      /^(02|03)[0-9a-f]{64}$/.test(signature.pubkey.toString("hex")))?.pubkey;
    const tapKey = psbt.data.inputs[index]?.tapInternalKey;
    if (p2sh && !partialKey) throw new Error("Nested SegWit fill input is missing its signer public key");
    return {
      txid: Buffer.from(input.hash).reverse().toString("hex"),
      vout: input.index,
      valueSats: witness.value,
      scriptHex,
      tokenAtoms: index === 0 ? listing.amountAtoms : 0n,
      ...(index === 0 ? { tokenDeploymentTxid: listing.deployTxid } : {}),
      ...(partialKey ? { publicKeyHex: partialKey.toString("hex") } :
        tapKey ? { publicKeyHex: tapKey.toString("hex") } : {}),
    };
  });
  const recipient = transaction.outs[2]!;
  const buyerScriptHex = recipient.script.toString("hex");
  const buyerFundingScriptHex = funding[1]!.scriptHex;
  if (funding.slice(1).some((coin) => coin.scriptHex !== buyerFundingScriptHex)) {
    throw new Error("Market fill buyer funding uses multiple payment scripts");
  }
  const totalIn = funding.reduce((sum, coin) => sum + coin.valueSats, 0);
  const totalOut = transaction.outs.reduce((sum, output) => sum + output.value, 0);
  const minerFeeSats = totalIn - totalOut;
  if (!Number.isSafeInteger(minerFeeSats) || minerFeeSats < 0 || minerFeeSats > 20_000) {
    throw new Error("Market fill miner fee is invalid");
  }
  const terms: CrcFillOptions = {
    listing, asset, sellerFunding: funding[0]!, buyerFunding: funding.slice(1),
    buyerScriptHex, protocolScriptHex: asset.protocolScriptHex,
    recipientSats: recipient.value, minerFeeSats, currentHeight,
    ...(buyerFundingScriptHex === buyerScriptHex ? {} : { buyerFundingScriptHex }),
  };
  verifyCrcFillTransaction(psbt, terms);
  return terms;
}

export async function signCrcSellerFillAfterReview(
  psbtBase64: string,
  terms: CrcFillOptions,
  walletScriptHex: string,
  signPsbt: (psbtBase64: string, operation: string) => Promise<string>,
  sellerPublicKeyHex?: string,
): Promise<string> {
  if (terms.listing.sellerScriptHex.toLowerCase() !== walletScriptHex.toLowerCase()) {
    throw new Error("Market fill seller does not match the connected wallet");
  }
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: networkParams(terms.listing.network) });
  verifyCrcFillTransaction(psbt, terms);
  if (/^5120[0-9a-f]{64}$/i.test(walletScriptHex) && sellerPublicKeyHex) {
    if (!/^[0-9a-f]{64}$/i.test(sellerPublicKeyHex)) {
      throw new Error("Seller Taproot public key is invalid");
    }
    const existing = psbt.data.inputs[0]?.tapInternalKey?.toString("hex");
    if (existing && existing.toLowerCase() !== sellerPublicKeyHex.toLowerCase()) {
      throw new Error("Seller Taproot key differs from reviewed transaction");
    }
    psbt.updateInput(0, { tapInternalKey: Buffer.from(sellerPublicKeyHex, "hex") });
  }
  return signPsbt(psbt.toBase64(), "CRC_MARKET_SELL");
}
