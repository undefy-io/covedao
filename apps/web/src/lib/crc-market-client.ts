import * as bitcoin from "bitcoinjs-lib";
import { signCrcMarketFillAfterReview } from "./crc-market-signing";
import type { CrcFillOptions, CrcListing } from "@crclaunch/cove-market/crc20/browser";

export type CrcMarketListing = Omit<CrcListing, "amountAtoms" | "expiresAtHeight"> & {
  amountAtoms: string;
  expiresAtHeight: string;
  status: string;
};

type MarketWallet = {
  network: string;
  script: string;
  publicKey: string;
  ordinalsScript: string;
  address: string;
  ordinalsAddress: string;
  signPsbt: (psbtBase64: string, operation: string) => Promise<string>;
};

type Request = (url: string, init?: RequestInit) => Promise<Response>;

async function data<T>(request: Request, url: string, init?: RequestInit): Promise<T> {
  const response = await request(url, init);
  const body = await response.json();
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error?.detail || body?.error?.message || `Request failed: ${response.status}`);
  }
  return body.data as T;
}

function outputAddress(scriptHex: string, network: string): string {
  const chain = network === "mainnet" ? bitcoin.networks.bitcoin :
    network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
  return bitcoin.address.fromOutputScript(Buffer.from(scriptHex, "hex"), chain);
}

function assertDecimal(value: string, name: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${name} is invalid`);
  return BigInt(value);
}

function safeSats(value: string, name: string): number {
  const sats = assertDecimal(value, name);
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} is too large`);
  return Number(sats);
}

function toListing(value: CrcMarketListing): CrcListing {
  return { ...value, amountAtoms: assertDecimal(value.amountAtoms, "listing amount"),
    expiresAtHeight: assertDecimal(value.expiresAtHeight, "listing expiry") };
}

export async function buyCrcMarketListing(
  listingRow: CrcMarketListing,
  wallet: MarketWallet,
  minerFeeSats: number,
  request: Request = fetch,
): Promise<{ fillId: string; txid: string }> {
  if (!Number.isSafeInteger(minerFeeSats) || minerFeeSats < 1 || minerFeeSats > 20_000) {
    throw new Error("Miner fee must be 1 to 20,000 sats");
  }
  const listing = toListing(listingRow);
  if (wallet.network !== listing.network) throw new Error("Wallet network differs from this marketplace");
  const addressNetwork = listing.network === "mainnet" ? bitcoin.networks.bitcoin :
    listing.network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
  if (!bitcoin.address.toOutputScript(wallet.address, addressNetwork).equals(Buffer.from(wallet.script, "hex"))) {
    throw new Error("Wallet address does not match connected payment script");
  }
  if (!bitcoin.address.toOutputScript(wallet.ordinalsAddress, addressNetwork).equals(Buffer.from(wallet.ordinalsScript, "hex"))) {
    throw new Error("Wallet token address does not match connected token script");
  }
  if (listingRow.status !== "OPEN") throw new Error("Listing is no longer open");
  const assetId = `${listing.network}:${listing.deployTxid}`;
  const sellerAddress = outputAddress(listing.sellerScriptHex, listing.network);
  const [assetResult, tokenResult, sellerResult, buyerResult] = await Promise.all([
    data<{ indexedTip: { height: string }; token: {
      network: string; deployTxid: string; ticker: string; protocolVersion: number;
      protocolScriptHex: string; vault: { scriptHex: string };
    } }>(request, `/api/crc/v1/tokens/${encodeURIComponent(assetId)}`, { cache: "no-store" }),
    data<{ utxos: { txid: string; vout: number; atoms: string; scriptHex: string }[]; truncated: boolean }>(
      request, `/api/crc/v1/tokens/${encodeURIComponent(assetId)}/utxos?address=${encodeURIComponent(sellerAddress)}`, { cache: "no-store" }),
    data<{ utxos: { txid: string; vout: number; valueSats: string }[] }>(
      request, `/api/crc/v1/wallet/utxos?address=${encodeURIComponent(sellerAddress)}`, { cache: "no-store" }),
    data<{ utxos: { txid: string; vout: number; valueSats: string }[] }>(
      request, `/api/crc/v1/wallet/utxos?address=${encodeURIComponent(wallet.address)}`, { cache: "no-store" }),
  ]);
  const token = tokenResult.utxos.find((coin) => coin.txid === listing.sellerAnchorTxid &&
    coin.vout === listing.sellerAnchorVout);
  const sellerCoin = sellerResult.utxos.find((coin) => coin.txid === listing.sellerAnchorTxid &&
    coin.vout === listing.sellerAnchorVout);
  if (tokenResult.truncated || !token || !sellerCoin || token.scriptHex.toLowerCase() !== listing.sellerScriptHex.toLowerCase() ||
    token.atoms !== listing.amountAtoms.toString() || safeSats(sellerCoin.valueSats, "seller carrier") !== listing.sellerAnchorSats) {
    throw new Error("Listed token output no longer matches the indexed allocation and Bitcoin funding");
  }
  const indexed = assetResult.token;
  if (indexed.network !== listing.network || indexed.deployTxid !== listing.deployTxid ||
    indexed.ticker !== listing.ticker || indexed.protocolVersion !== 3 ||
    indexed.vault.scriptHex.toLowerCase() === listing.sellerScriptHex.toLowerCase()) {
    throw new Error("Listing is not for the indexed Cove deployment");
  }
  const recipientSats = 1_000;
  const target = BigInt(listing.priceSats) + BigInt(listing.protocolFeeSats) +
    BigInt(recipientSats) + BigInt(minerFeeSats);
  if (buyerResult.utxos.length === 0) throw new Error("Not enough Bitcoin for this sale and miner fee");
  const checked = await data<{ tokenFreeOutpoints: { txid: string; vout: number }[] }>(request,
    "/api/crc/v1/market/funding-check", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ outpoints: buyerResult.utxos.slice(0, 256).map(({ txid, vout }) => ({ txid, vout })) }),
    });
  const tokenFree = new Set(checked.tokenFreeOutpoints.map((coin) => `${coin.txid}:${coin.vout}`));
  const buyerFunding: CrcFillOptions["buyerFunding"][number][] = [];
  let total = 0n;
  const chosen = new Set<string>();
  for (const coin of buyerResult.utxos) {
    const outpoint = `${coin.txid}:${coin.vout}`;
    if (!tokenFree.has(outpoint) || chosen.has(outpoint)) continue;
    if (coin.txid === listing.sellerAnchorTxid && coin.vout === listing.sellerAnchorVout) continue;
    const valueSats = safeSats(coin.valueSats, "buyer funding");
    if (valueSats <= 0) continue;
    chosen.add(outpoint);
    buyerFunding.push({ txid: coin.txid, vout: coin.vout, valueSats,
      scriptHex: wallet.script, tokenAtoms: 0n,
      ...(wallet.publicKey ? { publicKeyHex: wallet.publicKey } : {}) });
    total += BigInt(valueSats);
    if (total >= target) break;
    if (buyerFunding.length >= 20) break;
  }
  if (total < target) throw new Error("Not enough Bitcoin for this sale and miner fee");
  const sellerFunding = { txid: listing.sellerAnchorTxid, vout: listing.sellerAnchorVout,
    valueSats: listing.sellerAnchorSats, scriptHex: listing.sellerScriptHex,
    tokenAtoms: listing.amountAtoms, tokenDeploymentTxid: listing.deployTxid };
  const terms: CrcFillOptions = {
    listing, asset: { network: listing.network, deployTxid: indexed.deployTxid, ticker: indexed.ticker,
      protocolVersion: indexed.protocolVersion,
      tokenOutpoint: `${token.txid}:${token.vout}`, tokenScriptHex: token.scriptHex,
      tokenAtoms: BigInt(token.atoms), protocolScriptHex: indexed.protocolScriptHex,
      vaultScriptHex: indexed.vault.scriptHex },
    sellerFunding, buyerFunding, buyerScriptHex: wallet.ordinalsScript,
    buyerFundingScriptHex: wallet.script,
    protocolScriptHex: indexed.protocolScriptHex, recipientSats, minerFeeSats,
    currentHeight: assertDecimal(assetResult.indexedTip.height, "indexed height"),
  };
  const fillId = crypto.randomUUID();
  const reserved = await data<{ fillId: string; psbtBase64: string }>(request, "/api/crc/v1/market/reserve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ fillId, listingId: listing.id, buyerScriptHex: wallet.ordinalsScript,
      buyerFundingScriptHex: wallet.script,
      protocolScriptHex: indexed.protocolScriptHex, recipientSats, minerFeeSats,
      sellerFunding: { ...sellerFunding, tokenAtoms: sellerFunding.tokenAtoms.toString() },
      buyerFunding: buyerFunding.map((coin) => ({ ...coin, tokenAtoms: "0" })) }),
  });
  if (reserved.fillId !== fillId) throw new Error("Market reservation identity changed");
  const signedPsbtBase64 = await signCrcMarketFillAfterReview(reserved.psbtBase64, terms,
    wallet.ordinalsScript, wallet.signPsbt);
  const completed = await data<{ fillId: string; txid: string }>(request, "/api/crc/v1/market/buyer-sign", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ fillId, signedPsbtBase64 }),
  });
  if (completed.fillId !== fillId || !/^[0-9a-f]{64}$/.test(completed.txid)) {
    throw new Error("Market fill broadcast identity changed");
  }
  return completed;
}
