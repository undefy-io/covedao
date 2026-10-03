import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { signCrcReviewedPlan } from "./crc-browser-signing";
import { scriptOf } from "./wallets/resolve";
import type { CoveNetwork } from "./wallets/types";

export type CrcBrowserWallet = {
  network: string; address: string; publicKey: string;
  ordinalsAddress: string; ordinalsPublicKey?: string;
};
export type CrcBrowserBuild = { sessionId: string; psbtBase64: string; intent: Record<string, unknown> };
export type CrcBrowserReview = {
  operation: "deploy" | "buy" | "sell" | "transfer" | "listing" | "purchase" | "cancel";
  minerFeeSats: number; ticker?: string; assetId?: string; amountAtoms?: string;
  recipientScriptHex?: string; priceSats?: string; offer?: core.Offer;
};
export type CrcRequest = (url: string, init?: RequestInit) => Promise<Response>;
export async function crcBrowserData<T>(request: CrcRequest, url: string, body?: unknown): Promise<T> {
  const response = await request(url, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result?.ok !== true) throw new Error(result?.error?.detail || result?.error?.message || `Request failed: ${response.status}`);
  return result.data as T;
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
  return value;
}
// JSONB can reorder object keys. Array order and marker JSON string bytes
// remain significant when comparing the independently reconstructed plan.
const same = (a: unknown, b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const amount = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error("Invalid exact amount");
  return BigInt(value);
};
export function crcBrowserScript(address: string, network: string): string {
  if (/^(bc1p|tb1p|bcrt1p)/.test(address)) {
    const decoded = bitcoin.address.fromBech32(address);
    const expected = core.protocolNetwork(network) === "bitcoin" ? "bc" : network === "regtest" ? "bcrt" : "tb";
    if (decoded.prefix !== expected || decoded.version !== 1 || decoded.data.length !== 32) throw new Error("Wallet address network mismatch");
    return `5120${decoded.data.toString("hex")}`;
  }
  return scriptOf(address, (network === "bitcoin" ? "mainnet" : network) as CoveNetwork);
}
function scriptAddress(script: string, network: string): string {
  const params = network === "bitcoin" ? bitcoin.networks.bitcoin : network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
  if (script.startsWith("5120")) return bitcoin.address.toBech32(Buffer.from(script.slice(4), "hex"), 1, params.bech32);
  return bitcoin.address.fromOutputScript(Buffer.from(script, "hex"), params);
}

/** Reconstruct economics with core builders, then verify PSBT and wallet response with shared adapters. */
export async function signCrcBuildSession(
  built: CrcBrowserBuild, review: CrcBrowserReview, wallet: CrcBrowserWallet,
  signPsbt: (psbtBase64: string, operation: string) => Promise<string>, request: CrcRequest = fetch,
): Promise<string> {
  const network = core.protocolNetwork(wallet.network);
  const plan = core.decodeProtocolDto<core.Plan>(built.intent.corePlan);
  const config = core.decodeProtocolDto<core.Config>(built.intent.coreConfig);
  core.validateConfig(config);
  if (config.network !== network || !Number.isSafeInteger(review.minerFeeSats) ||
    built.intent.minerFeeSats !== review.minerFeeSats || plan.minerFeeSats !== BigInt(review.minerFeeSats)) throw new Error("Reviewed network or miner fee changed");
  const paymentScript = crcBrowserScript(wallet.address, network);
  const tokenAddress = wallet.ordinalsAddress || wallet.address;
  const tokenScript = crcBrowserScript(tokenAddress, network);
  const accounts = [{ address: wallet.address, publicKey: wallet.publicKey },
    { address: tokenAddress, publicKey: wallet.ordinalsPublicKey || wallet.publicKey }];
  const addresses = [...new Set(accounts.map((a) => a.address))];
  const bitcoinRows = await Promise.all(addresses.map(async (address) => ({ address, data:
    await crcBrowserData<{ utxos: { txid: string; vout: number; valueSats: string; confirmations: number }[] }>(request, `/api/crc/v1/wallet/utxos?address=${encodeURIComponent(address)}`) })));
  const observed = new Map(bitcoinRows.flatMap(({ address, data }) => data.utxos.filter((coin) => coin.confirmations > 0)
    .map((coin) => [core.outpoint(coin), { sats: amount(coin.valueSats), scriptHex: crcBrowserScript(address, network) }] as const)));
  const ledger = core.emptyLedger(config);
  let asset: core.Asset | undefined;
  let height = 0;
  if (review.operation === "deploy") {
    const authority = await crcBrowserData<{ network: string; protocolScriptHex: string }>(request, "/api/crc/v1/trading/status");
    if (core.protocolNetwork(authority.network) !== network || authority.protocolScriptHex !== config.protocolScriptHex ||
      config.creatorScriptHex !== paymentScript || config.ticker !== review.ticker || built.intent.ticker !== review.ticker ||
      built.intent.launchFeeSats !== Number(core.launchFeeSats) || built.intent.vaultAnchorSats !== Number(core.carrierSats) ||
      built.intent.creatorRecordSats !== Number(core.carrierSats)) throw new Error("Reviewed launch terms changed");
  } else {
    if (!review.assetId || built.intent.assetId !== review.assetId) throw new Error("Reviewed asset changed");
    const detail = await crcBrowserData<{ token: { coreState: unknown }; indexedTip: { height: string; blockHash: string } }>(request, `/api/crc/v1/tokens/${encodeURIComponent(review.assetId)}`);
    asset = core.decodeProtocolDto<core.Asset>(detail.token.coreState);
    core.validateConfig(asset.config);
    if (`${wallet.network}:${asset.deployTxid}` !== review.assetId || !same(core.encodeProtocolDto(asset.config), core.encodeProtocolDto(config))) throw new Error("Indexed asset differs from build");
    ledger.assets[asset.deployTxid] = asset;
    height = Number(amount(detail.indexedTip.height));
    if (!Number.isSafeInteger(height)) throw new Error("Invalid indexed height");
    ledger.tip = { height, hash: detail.indexedTip.blockHash, fingerprint: "" };
    const owners = [...new Set(plan.inputs.filter((input) => input.atoms !== undefined && core.outpoint(input) !== core.outpoint(asset!.vault)).map((input) => input.scriptHex))];
    await Promise.all(owners.map(async (owner) => {
      const address = scriptAddress(owner, network);
      const rows = await crcBrowserData<{ utxos: { txid: string; vout: number; atoms: string; btcSats: string; scriptHex: string }[]; truncated: boolean }>(request,
        `/api/crc/v1/tokens/${encodeURIComponent(review.assetId!)}/utxos?address=${encodeURIComponent(address)}`);
      if (rows.truncated) throw new Error("Token output list is truncated");
      for (const input of rows.utxos) ledger.allocations[core.outpoint(input)] = {
        atoms: amount(input.atoms), sats: amount(input.btcSats), scriptHex: input.scriptHex, deployTxid: asset!.deployTxid,
      };
    }));
  }
  const tokens = plan.inputs.filter((input) => input.atoms !== undefined && (!asset || core.outpoint(input) !== core.outpoint(asset.vault)));
  for (const input of tokens) {
    const allocation = ledger.allocations[core.outpoint(input)];
    if (!allocation || allocation.atoms !== input.atoms || allocation.sats !== core.sats(input.sats) || allocation.scriptHex !== input.scriptHex || (input.deployTxid !== undefined && input.deployTxid !== allocation.deployTxid)) throw new Error("Indexed token input changed");
  }
  const funding = plan.inputs.filter((input) => !tokens.includes(input) && (!asset || core.outpoint(input) !== core.outpoint(asset.vault)));
  for (const input of funding) {
    const actual = observed.get(core.outpoint(input));
    if (!actual || actual.sats !== core.sats(input.sats) || actual.scriptHex !== input.scriptHex || input.atoms !== undefined || input.deployTxid !== undefined) throw new Error("Observed Bitcoin funding differs from plan");
  }
  if (review.amountAtoms !== undefined && built.intent.amountAtoms !== review.amountAtoms) throw new Error("Reviewed token amount changed");
  const minerFeeSats = BigInt(review.minerFeeSats);
  let expected: core.Plan;
  const guardianPending = review.operation === "buy" || review.operation === "sell";
  if (review.operation === "deploy") expected = core.buildDeploy({ config, funding, changeScriptHex: paymentScript, minerFeeSats });
  else if (guardianPending) {
    const args = { state: asset!, inputs: tokens, funding, amountAtoms: amount(review.amountAtoms), recipientScriptHex: tokenScript, changeScriptHex: paymentScript, minerFeeSats };
    expected = review.operation === "sell" ? core.buildSell(args) : (asset!.inventoryAtoms ? core.buildInventoryBuy : core.buildMint)(args);
    const operation = review.operation === "sell" ? "sell" : asset!.inventoryAtoms ? "inventory-buy" : "mint-buy";
    if (built.intent.operation !== operation) throw new Error("Trade operation changed");
  } else if (review.operation === "transfer" || review.operation === "listing") {
    if (built.intent.operation !== review.operation) throw new Error("Token operation changed");
    expected = (review.operation === "listing" ? core.buildListing : core.buildTransfer)({ network, deployTxid: asset!.deployTxid, ticker: config.ticker, inputs: tokens, funding,
      amountAtoms: amount(review.amountAtoms), recipientScriptHex: review.recipientScriptHex, sellerScriptHex: tokenScript, changeScriptHex: paymentScript, minerFeeSats,
      ...(review.priceSats ? { priceSats: amount(review.priceSats) } : {}) });
  } else {
    const offer = review.offer;
    if (!offer || built.intent.operation !== review.operation || built.intent.offerId !== core.offerId(offer)) throw new Error("Reviewed offer changed");
    core.verifyOffer(offer);
    if (offer.network !== network || offer.deployTxid !== asset!.deployTxid || offer.ticker !== config.ticker) throw new Error("Offer asset mismatch");
    ledger.offers[core.offerId(offer)] = { ...offer, status: "open" };
    expected = review.operation === "purchase" ? core.buildPurchase({ offer, currentHeight: height, buyerFunding: funding, buyerScriptHex: tokenScript, protocolScriptHex: config.protocolScriptHex, changeScriptHex: paymentScript, minerFeeSats })
      : core.buildCancel({ offer, funding, changeScriptHex: paymentScript, minerFeeSats });
  }
  if (!same(core.encodeProtocolDto(expected), core.encodeProtocolDto(plan))) throw new Error("Server plan differs from reconstructed core terms");
  for (let offset = 0; offset < funding.length; offset += 40) {
    const outpoints = funding.slice(offset, offset + 40).map(({ txid, vout }) => ({ txid, vout }));
    const checked = await crcBrowserData<{ tokenFreeOutpoints: { txid: string; vout: number }[] }>(request,
      "/api/crc/v1/market/funding-check", { outpoints });
    const tokenFree = new Set(checked.tokenFreeOutpoints.map(core.outpoint));
    if (outpoints.some((coin) => !tokenFree.has(core.outpoint(coin)))) throw new Error("Reviewed Bitcoin funding contains a token carrier or vault");
  }
  return signCrcReviewedPlan({ plan: expected, psbtBase64: built.psbtBase64, ledger, network, accounts, guardianPending, operation: `CRC_${review.operation.toUpperCase()}` }, signPsbt);
}

/** Exact ordinary-wallet BTC movement from the reviewed core plan, including released carrier credits. */
export function crcBuiltWalletDelta(built: CrcBrowserBuild): bigint {
  const plan = core.decodeProtocolDto<core.Plan>(built.intent.corePlan);
  const curve = ["sell", "mint-buy", "inventory-buy"].includes(String(built.intent.operation));
  const ordinary = plan.inputs.filter((input, index) => !(curve && index === 0) && input.atoms === undefined);
  const returned = plan.outputs.filter((output) => output.role === "btcChange" || output.role === "payout");
  return ordinary.reduce((sum, input) => sum + core.sats(input.sats), 0n) - returned.reduce((sum, output) => sum + output.sats, 0n);
}
