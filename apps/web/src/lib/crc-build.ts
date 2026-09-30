import { createHash, randomBytes } from "node:crypto";
import type * as bitcoin from "bitcoinjs-lib";
import { unsignedTxDigest } from "@crclaunch/cove-app";
import { buildCoveDeployWithVault, buildCurveBuy, buildCurveSell, buildUnsignedPsbt, selectCrcFunding, type FundingInput } from "@crclaunch/crc20-transactions";
import type { VaultRecoveryProfile } from "@crclaunch/cove-vault";
import type { Database } from "@crclaunch/db";
import { loadCrcFundingCandidates, type CrcFundingOutpoint } from "./crc-funding";
import { createCrcBuildSession } from "./crc-session";
import { crcCurveStateFromAsset, quoteCrcBuy, quoteCrcSell, type CrcQuoteAsset } from "./crc-quote";

export async function buildCrcLaunchSession(params: {
  db: Database;
  network: "regtest" | "signet" | "testnet" | "mainnet";
  bitcoinNetwork: bitcoin.networks.Network;
  ticker: string;
  walletScriptHex: string;
  tokenScriptHex: string;
  walletPublicKeyHex?: string;
  funding: CrcFundingOutpoint[];
  minerFeeSats: number;
  idempotencyKey: string;
  feeScriptHex: string;
  guardianXOnly: Buffer;
  recoveryProfile: VaultRecoveryProfile;
}) {
  if (!/^[A-Z0-9]{1,16}$/.test(params.ticker)) throw new Error("ticker must be 1-16 uppercase letters or digits");
  const launchSalt = randomBytes(32);
  const base = {
    ticker: params.ticker,
    launchSalt,
    guardianXOnly: params.guardianXOnly,
    recoveryProfile: params.recoveryProfile,
    creatorScriptHex: params.walletScriptHex,
    protocolScriptHex: params.feeScriptHex,
    vaultAnchorSats: 330,
    network: params.bitcoinNetwork,
  };
  const first = buildCoveDeployWithVault(base);
  const candidates = await loadCrcFundingCandidates(params.db, params.network, params.walletScriptHex, params.funding, {
    publicKeyHex: params.walletPublicKeyHex,
  });
  const selected = selectCrcFunding({
    mandatoryInputs: [], candidates,
    outputsSats: first.template.outputs.reduce((sum, output) => sum + output.valueSats, 0),
    minerFeeSats: params.minerFeeSats,
    changeScriptHex: params.walletScriptHex,
  });
  const built = buildCoveDeployWithVault({
    ...base,
    changeSats: selected.changeSats,
    changeScriptHex: params.walletScriptHex,
  });
  const psbt = buildUnsignedPsbt(built.template, selected.inputs, selected.minerFeeSats, params.bitcoinNetwork);
  const psbtBase64 = psbt.toBase64();
  const digest = unsignedTxDigest(psbt);
  const requestHash = createHash("sha256").update(JSON.stringify({
    network: params.network, ticker: params.ticker, walletScriptHex: params.walletScriptHex,
    tokenScriptHex: params.tokenScriptHex, funding: params.funding,
    minerFeeSats: params.minerFeeSats, feeScriptHex: params.feeScriptHex,
    guardianXOnly: params.guardianXOnly.toString("hex"),
    recoveryProfile: {
      version: params.recoveryProfile.profileVersion,
      csvBlocks: params.recoveryProfile.recoveryCsvBlocks,
      threshold: params.recoveryProfile.recoveryThreshold,
      pubkeys: params.recoveryProfile.recoveryPubkeys.map((key) => key.toString("hex")),
    },
  })).digest("hex");
  const intent = {
    operation: "deploy" as const,
    ticker: params.ticker,
    vaultScriptHex: built.vault.scriptPubKey.toString("hex"),
    creatorScriptHex: params.walletScriptHex,
    protocolScriptHex: params.feeScriptHex,
    vaultAnchorSats: 330,
    creatorRecordSats: 1_000,
    launchFeeSats: 7_000,
    minerFeeSats: selected.minerFeeSats,
    changeSats: selected.changeSats,
    unsignedTxDigest: digest,
  };
  const session = await createCrcBuildSession(params.db, {
    network: params.network,
    operation: "deploy",
    deploymentTxid: null,
    idempotencyKey: params.idempotencyKey,
    requestHash,
    unsignedTxDigest: digest,
    psbtBase64,
    walletScriptHex: params.walletScriptHex,
    tokenScriptHex: params.tokenScriptHex,
    trustedJson: { ...intent, launchSaltHex: launchSalt.toString("hex") },
  });
  return {
    sessionId: session.id,
    psbtBase64: session.psbtBase64,
    intent: session.trustedJson as typeof intent & { launchSaltHex: string },
  };
}

export type CrcTradeAsset = CrcQuoteAsset & {
  network: "regtest" | "signet" | "testnet" | "mainnet";
  deployTxid: string;
  ticker: string;
  creatorScriptHex: string;
  protocolScriptHex: string;
  registeredVaultScriptHex: string;
  vault: CrcQuoteAsset["vault"] & { scriptHex: string };
};

export async function buildCrcTradeSession(params: {
  db: Database;
  network: "regtest" | "signet" | "testnet" | "mainnet";
  bitcoinNetwork: bitcoin.networks.Network;
  asset: CrcTradeAsset;
  operation: "buy" | "sell";
  amountAtoms: bigint;
  walletScriptHex: string;
  tokenScriptHex: string;
  walletPublicKeyHex?: string;
  tokenPublicKeyHex?: string;
  sellerFunding?: CrcFundingOutpoint;
  verifiedSellerInput?: FundingInput;
  paymentFunding: CrcFundingOutpoint[];
  minerFeeSats: number;
  idempotencyKey: string;
  feeScriptHex: string;
}) {
  const { asset } = params;
  if (asset.network !== params.network || asset.assetId !== `${params.network}:${asset.deployTxid}` ||
    asset.vault.scriptHex !== asset.registeredVaultScriptHex ||
    asset.protocolScriptHex !== params.feeScriptHex) {
    throw new Error("CRC asset does not match trusted launch configuration");
  }
  if (params.amountAtoms <= 0n || params.amountAtoms % 100_000_000n !== 0n) {
    throw new Error("CRC trade amount must contain whole tokens");
  }
  const state = crcCurveStateFromAsset(asset);
  const quote = params.operation === "buy"
    ? quoteCrcBuy(asset, params.amountAtoms)
    : quoteCrcSell(asset, params.amountAtoms, params.walletScriptHex);
  const vaultInput = {
    txid: asset.vault.txid, vout: asset.vault.vout,
    valueSats: Number(asset.vault.btcSats), scriptHex: asset.vault.scriptHex,
  };
  if (!Number.isSafeInteger(vaultInput.valueSats)) throw new Error("CRC vault value exceeds safe integer");
  if (params.verifiedSellerInput &&
    (!params.sellerFunding || params.verifiedSellerInput.txid !== params.sellerFunding.txid ||
      params.verifiedSellerInput.vout !== params.sellerFunding.vout ||
      params.verifiedSellerInput.scriptHex !== params.tokenScriptHex)) {
    throw new Error("verified CRC seller input does not match wallet intent");
  }
  const sellerInputs = params.operation === "sell" && params.verifiedSellerInput
    ? [params.verifiedSellerInput]
    : params.operation === "sell" && params.sellerFunding
    ? await loadCrcFundingCandidates(params.db, params.network, params.tokenScriptHex, [params.sellerFunding], {
      allowCarrier: true, publicKeyHex: params.tokenPublicKeyHex,
    }) : [];
  if (params.operation === "sell" && sellerInputs.length !== 1) throw new Error("CRC seller token carrier is required");
  const paymentOutpoints = params.paymentFunding.filter((coin) =>
    !params.sellerFunding || coin.txid !== params.sellerFunding.txid || coin.vout !== params.sellerFunding.vout);
  const candidates = await loadCrcFundingCandidates(params.db, params.network, params.walletScriptHex, paymentOutpoints, {
    publicKeyHex: params.walletPublicKeyHex,
  });
  const scripts = {
    buyer: params.tokenScriptHex,
    seller: params.tokenScriptHex,
    vault: asset.vault.scriptHex,
    protocol: asset.protocolScriptHex,
    creator: asset.creatorScriptHex,
  };
  const common = {
    ticker: asset.ticker, deploymentTxid: asset.deployTxid, state,
    amountTokens: params.amountAtoms / 100_000_000n, scripts,
  };
  const makeTemplate = (changeSats?: number) => params.operation === "buy"
    ? buildCurveBuy({ ...common, recipientSats: 1_000, changeSats, changeScriptHex: params.walletScriptHex })
    : buildCurveSell({ ...common, sellerPayoutScriptHex: params.walletScriptHex,
      changeSats, changeScriptHex: params.walletScriptHex });
  const base = makeTemplate();
  const selected = selectCrcFunding({
    mandatoryInputs: [vaultInput, ...sellerInputs], candidates,
    outputsSats: base.outputs.reduce((sum, output) => sum + output.valueSats, 0),
    minerFeeSats: params.minerFeeSats, changeScriptHex: params.walletScriptHex,
  });
  const built = makeTemplate(selected.changeSats);
  const psbt = buildUnsignedPsbt(built, selected.inputs, selected.minerFeeSats, params.bitcoinNetwork);
  const psbtBase64 = psbt.toBase64();
  const digest = unsignedTxDigest(psbt);
  const requestHash = createHash("sha256").update(JSON.stringify({
    network: params.network, assetId: asset.assetId, vaultOutpoint: quote.vaultOutpoint,
    operation: params.operation, amountAtoms: params.amountAtoms.toString(),
    walletScriptHex: params.walletScriptHex, tokenScriptHex: params.tokenScriptHex,
    sellerFunding: params.sellerFunding, paymentFunding: params.paymentFunding,
    minerFeeSats: params.minerFeeSats, feeScriptHex: params.feeScriptHex,
  })).digest("hex");
  const sessionOperation = params.operation === "sell" ? "sell"
    : quote.operation === "mint" ? "mint-buy" : "inventory-buy";
  const intent = {
    operation: sessionOperation,
    assetId: asset.assetId,
    amountAtoms: params.amountAtoms.toString(),
    vaultOutpoint: quote.vaultOutpoint,
    walletScriptHex: params.walletScriptHex,
    tokenScriptHex: params.tokenScriptHex,
    minerFeeSats: selected.minerFeeSats,
    changeSats: selected.changeSats,
    unsignedTxDigest: digest,
    quote,
  };
  const session = await createCrcBuildSession(params.db, {
    network: params.network, operation: sessionOperation,
    deploymentTxid: asset.deployTxid,
    idempotencyKey: params.idempotencyKey,
    requestHash, unsignedTxDigest: digest, psbtBase64,
    walletScriptHex: params.walletScriptHex, tokenScriptHex: params.tokenScriptHex,
    trustedJson: intent,
  });
  return { sessionId: session.id, psbtBase64: session.psbtBase64, intent: session.trustedJson as typeof intent };
}
