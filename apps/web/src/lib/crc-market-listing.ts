import * as core from "@crclaunch/crc20-protocol";
import {
  crcBrowserData,
  crcBrowserScript,
  crcBuiltWalletDelta,
  signCrcBuildSession,
  type CrcBrowserBuild,
  type CrcBrowserWallet,
  type CrcRequest,
} from "./crc-browser-session";
import { submitCrcFromBrowser } from "./crc-client-broadcast";
import { selectCrcListingCoins, type CrcListingCoin } from "./crc-market-amount";
import { crcWalletData } from "./crc-wallet-data";
import type { CrcMarketListing } from "./crc-market-client";

export type CrcListingWallet = CrcBrowserWallet & {
  script: string;
  ordinalsScript: string;
  signPsbt: (psbt: string, operation: string) => Promise<string>;
  signBip322: (message: string) => Promise<string>;
};
export type SellerSnapshot = {
  token: {
    assetId: string;
    network: string;
    deployTxid: string;
    ticker: string;
    coreState: unknown;
  };
  height: number;
  coins: CrcListingCoin[];
  listings: CrcMarketListing[];
  unavailableOutpoints: { txid: string; vout: number }[];
  truncated: boolean;
};
export type AmountListingReview = {
  assetId: string;
  amountAtoms: bigint;
  priceSats: bigint;
  expiryBlocks: number;
  selected: CrcListingCoin[];
  changeAtoms: bigint;
  built?: CrcBrowserBuild;
  walletDeltaSats: bigint;
  escrowTerms?: core.EscrowTerms;
};
export type PreparedListing = { txid: string; coin: CrcListingCoin; review: AmountListingReview };
type Guard = () => void;
const unchanged: Guard = () => {};
function validateWallet(wallet: CrcListingWallet) {
  if (
    crcBrowserScript(wallet.address, wallet.network) !== wallet.script ||
    crcBrowserScript(wallet.ordinalsAddress, wallet.network) !== wallet.ordinalsScript
  )
    throw new Error("Wallet network or address changed");
  core.canonicalOfferPublicKey(
    (wallet.ordinalsPublicKey || wallet.publicKey).toLowerCase(),
    wallet.ordinalsScript,
  );
}
export async function loadCrcSellerSnapshot(
  assetId: string,
  wallet: CrcListingWallet,
  request: CrcRequest = fetch,
): Promise<SellerSnapshot> {
  validateWallet(wallet);
  const [detail, tokens, market] = await Promise.all([
    crcBrowserData<{ token: SellerSnapshot["token"]; indexedTip: { height: string } }>(
      request,
      `/api/crc/v1/tokens/${encodeURIComponent(assetId)}`,
    ),
    crcBrowserData<{ utxos: CrcListingCoin[]; truncated: boolean }>(
      request,
      `/api/crc/v1/tokens/${encodeURIComponent(assetId)}/utxos?address=${encodeURIComponent(wallet.ordinalsAddress)}`,
    ),
    crcBrowserData<{
      active: boolean;
      listings: CrcMarketListing[];
      unavailableOutpoints: { txid: string; vout: number }[];
      truncated: boolean;
    }>(
      request,
      `/api/crc/v1/market/listings?sellerScriptHex=${encodeURIComponent(wallet.ordinalsScript)}`,
    ),
  ]);
  if (!market.active) throw new Error("Marketplace trading is currently paused");
  if (
    typeof market.truncated !== "boolean" ||
    !Array.isArray(market.unavailableOutpoints) ||
    typeof tokens.truncated !== "boolean"
  )
    throw new Error("Refresh this page to load complete seller availability");
  const state = core.decodeProtocolDto<core.Asset>(detail.token.coreState);
  core.validateConfig(state.config);
  if (
    detail.token.network !== wallet.network ||
    detail.token.assetId !== assetId ||
    `${wallet.network}:${state.deployTxid}` !== assetId ||
    state.config.network !== core.protocolNetwork(wallet.network) ||
    tokens.utxos.some((c) => c.scriptHex !== wallet.ordinalsScript)
  )
    throw new Error("Indexed token differs from wallet or selected asset");
  const height = Number(detail.indexedTip.height);
  if (!Number.isSafeInteger(height) || height < 0) throw new Error("Invalid indexed height");
  return {
    token: detail.token,
    height,
    coins: tokens.utxos,
    listings: market.listings,
    unavailableOutpoints: market.unavailableOutpoints,
    truncated: tokens.truncated || market.truncated,
  };
}
async function observeCoins(
  coins: CrcListingCoin[],
  wallet: CrcListingWallet,
  guard: Guard,
  request: CrcRequest,
) {
  guard();
  const live = await crcWalletData(wallet.network, request).observe(
    [wallet.ordinalsAddress],
    coins.map((c) => ({
      txid: c.txid,
      vout: c.vout,
      sats: BigInt(c.btcSats),
      scriptHex: c.scriptHex,
    })),
  );
  guard();
  if (
    coins.some(
      (c) =>
        !live.some(
          (l) =>
            core.outpoint(c) === core.outpoint(l) &&
            l.scriptHex === c.scriptHex &&
            l.valueSats === c.btcSats &&
            (l.confirmations ?? 0) >= 1,
        ),
    )
  )
    throw new Error("Selected tokens are no longer confirmed and available. Review again.");
}
export async function reviewCrcAmountListing(
  args: {
    assetId: string;
    amountAtoms: bigint;
    priceSats: bigint;
    expiryBlocks: number;
  },
  wallet: CrcListingWallet,
  request: CrcRequest = fetch,
  guard: Guard = unchanged,
): Promise<AmountListingReview> {
  guard();
  validateWallet(wallet);
  const snapshot = await loadCrcSellerSnapshot(args.assetId, wallet, request);
  guard();
  const selected = selectCrcListingCoins(
    snapshot.coins,
    args.amountAtoms,
    snapshot.unavailableOutpoints,
    snapshot.truncated,
  );
  await observeCoins(selected, wallet, guard, request);
  if (!Number.isSafeInteger(args.expiryBlocks) || args.expiryBlocks < 1 || args.expiryBlocks > 2016)
    throw new Error("Expiry must be 1 to 2,016 blocks");
  const state = core.decodeProtocolDto<core.Asset>(snapshot.token.coreState);
  if (!state.config.guardianCustody) throw new Error("Marketplace escrow custody is unavailable");
  const terms: core.EscrowTerms = {
    version: 1,
    network: state.config.network,
    deployTxid: state.deployTxid,
    ticker: state.config.ticker,
    amountAtoms: args.amountAtoms,
    priceSats: args.priceSats,
    sellerTokenScriptHex: wallet.ordinalsScript,
    sellerPayoutScriptHex: wallet.script,
    sellerAuthorityScriptHex: wallet.script,
    protocolScriptHex: state.config.protocolScriptHex,
    feePolicy: "market-v1",
    expiryHeight: snapshot.height + args.expiryBlocks,
    guardianPublicKeyHex: state.config.guardianCustody.guardianPublicKeyHex,
    nonceHex: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  };
  core.validateEscrowConfig(terms, state.config);
  const total = selected.reduce((sum, c) => sum + BigInt(c.atoms), 0n);
  const review: AmountListingReview = {
    ...args,
    selected,
    changeAtoms: total - args.amountAtoms,
    walletDeltaSats: 0n,
  };

  const rates = await crcBrowserData<{ tiers: { key: string; satPerVb: string }[] }>(
    request,
    "/api/crc/v1/fees",
  );
  guard();
  const tier = rates.tiers.find((t) => t.key === "standard") ?? rates.tiers[0];
  if (!tier || !/^[1-9]\d{0,2}$/.test(tier.satPerVb) || Number(tier.satPerVb) > 500)
    throw new Error("Network fee estimate is unavailable. Try again shortly.");
  const feeRateSatPerVb = Number(tier.satPerVb);
  const data = crcWalletData(wallet.network, request);
  const coins = await data.coins(wallet.address);
  guard();
  const candidates = coins
    .filter((c) => (c.confirmations ?? 0) > 0)
    .slice(0, 40)
    .map(({ txid, vout }) => ({ txid, vout }));
  let allowed: { txid: string; vout: number }[] = [];
  if (candidates.length) {
    const checked = await crcBrowserData<{ tokenFreeOutpoints: { txid: string; vout: number }[] }>(
      request,
      "/api/crc/v1/market/funding-check",
      { outpoints: candidates },
    );
    guard();
    const keys = new Set(checked.tokenFreeOutpoints.map(core.outpoint));
    allowed = candidates.filter((c) => keys.has(core.outpoint(c)));
  }
  const evidence = allowed.length
    ? await data.funding(wallet.address, allowed, [wallet.address, wallet.ordinalsAddress])
    : { funding: [], fundingEvidence: undefined };
  guard();
  const built = await crcBrowserData<CrcBrowserBuild>(request, "/api/crc/v1/market/listing-build", {
    deployTxid: snapshot.token.deployTxid,
    tokenFunding: selected.map(({ txid, vout }) => ({ txid, vout })),
    paymentFunding: evidence.funding,
    fundingEvidence: evidence.fundingEvidence,
    walletScriptHex: wallet.script,
    tokenScriptHex: wallet.ordinalsScript,
    walletPublicKeyHex: wallet.publicKey,
    tokenPublicKeyHex: wallet.ordinalsPublicKey || wallet.publicKey,
    recipientScriptHex: wallet.ordinalsScript,
    escrowTerms: core.encodeProtocolDto(terms),
    amountAtoms: args.amountAtoms.toString(),
    priceSats: args.priceSats.toString(),
    feeRateSatPerVb,
    idempotencyKey: crypto.randomUUID(),
  });
  guard();
  const plan = core.decodeProtocolDto<core.Plan>(built.intent.corePlan);
  if (
    built.intent.operation !== "listing" ||
    built.intent.assetId !== args.assetId ||
    built.intent.amountAtoms !== args.amountAtoms.toString() ||
    built.intent.priceSats !== args.priceSats.toString() ||
    built.intent.feeRateSatPerVb !== feeRateSatPerVb ||
    !Number.isSafeInteger(built.intent.minerFeeSats) ||
    plan.minerFeeSats < 1n ||
    plan.minerFeeSats > core.maxMinerFeeSats ||
    plan.minerFeeSats !== BigInt(String(built.intent.minerFeeSats)) ||
    plan.changeAtoms !== review.changeAtoms
  )
    throw new Error("Listing build differs from reviewed terms");
  const tokenInputs = plan.inputs.filter((input) => input.atoms !== undefined);
  const recipient = plan.outputs.filter((output) => output.role === "recipient");
  if (
    tokenInputs.length !== selected.length ||
    tokenInputs.some((input, index) => {
      const coin = selected[index]!;
      return (
        core.outpoint(input) !== core.outpoint(coin) ||
        input.atoms !== BigInt(coin.atoms) ||
        core.sats(input.sats) !== BigInt(coin.btcSats) ||
        input.scriptHex !== coin.scriptHex
      );
    }) ||
    recipient.length !== 1 ||
    recipient[0]!.atoms !== args.amountAtoms ||
    recipient[0]!.scriptHex !== core.escrowCustody(terms).scriptHex
  )
    throw new Error("Listing build changed selected tokens or seller output");

  const received = core.decodeProtocolDto<core.EscrowTerms>(built.intent.escrowTerms);
  if (core.escrowTermsMessage(received) !== core.escrowTermsMessage(terms))
    throw new Error("Escrow terms changed");
  return { ...review, built, escrowTerms: terms, walletDeltaSats: crcBuiltWalletDelta(built) };
}
export async function prepareCrcAmountListing(
  review: AmountListingReview,
  wallet: CrcListingWallet,
  request: CrcRequest = fetch,
  guard: Guard = unchanged,
): Promise<PreparedListing> {
  guard();
  if (!review.built || !review.escrowTerms) throw new Error("Review escrow listing first");
  const snapshot = await loadCrcSellerSnapshot(review.assetId, wallet, request);
  guard();
  if (
    snapshot.truncated ||
    review.selected.some(
      (c) =>
        !snapshot.coins.some(
          (l) =>
            core.outpoint(c) === core.outpoint(l) && c.atoms === l.atoms && c.btcSats === l.btcSats,
        ) || snapshot.unavailableOutpoints.some((l) => core.outpoint(c) === core.outpoint(l)),
    )
  )
    throw new Error("Available tokens changed. Review again.");
  await observeCoins(review.selected, wallet, guard, request);
  const built = review.built,
    fee = Number(built.intent.minerFeeSats);
  const sign = () =>
    signCrcBuildSession(
      built,
      {
        operation: "listing",
        assetId: review.assetId,
        amountAtoms: review.amountAtoms.toString(),
        priceSats: review.priceSats.toString(),
        recipientScriptHex: wallet.ordinalsScript,
        escrowTerms: review.escrowTerms,
        minerFeeSats: fee,
      },
      wallet,
      async (psbt, operation) => {
        guard();
        const signed = await wallet.signPsbt(psbt, operation);
        guard();
        return signed;
      },
      request,
    );
  const result = await submitCrcFromBrowser(
    built,
    wallet,
    "/api/crc/v1/market/listing-submit",
    sign,
    request,
  );
  guard();
  if (!/^[0-9a-f]{64}$/.test(result.txid))
    throw new Error("Preparation transaction identity changed");
  const plan = core.decodeProtocolDto<core.Plan>(built.intent.corePlan);
  const vout = plan.outputs.findIndex((o) => o.role === "recipient");
  const output = plan.outputs[vout];
  if (
    !output ||
    output.atoms !== review.amountAtoms ||
    output.scriptHex !== core.escrowCustody(review.escrowTerms!).scriptHex
  )
    throw new Error("Prepared output differs from reviewed amount");
  return {
    txid: result.txid,
    review,
    coin: {
      txid: result.txid,
      vout,
      atoms: review.amountAtoms.toString(),
      btcSats: output.sats.toString(),
      scriptHex: output.scriptHex,
    },
  };
}
