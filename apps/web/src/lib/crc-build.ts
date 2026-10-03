import { createHash, randomBytes } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { createPlanPsbt, describeCurveBuy } from "@crclaunch/crc20-adapters";
import { loadCrcCoreLedger } from "@crclaunch/crc20-state";
import { AppError, unsignedTxDigest } from "@crclaunch/cove-app";
import {
  buildCrc20AssetVault,
  crc20DeploymentTag,
  crc20AssetCommitment,
  type VaultRecoveryProfile,
} from "@crclaunch/cove-vault";
import type { Database } from "@crclaunch/db";
import {
  loadCrcFundingCandidates,
  crcWalletMetadata,
  type CrcFundingOutpoint,
  type CrcObservedInput,
} from "./crc-funding";
import { createCrcBuildSession, findCrcBuildSessionByKey } from "./crc-session";
import { quoteCrcBuy, quoteCrcSell, type CrcQuoteAsset } from "./crc-quote";
import { parseCrcLaunchMetadata, type CrcLaunchMetadata } from "./crc-metadata";
type Common = {
  db: Database;
  network: "regtest" | "signet" | "testnet" | "mainnet";
  bitcoinNetwork: bitcoin.networks.Network;
  walletScriptHex: string;
  tokenScriptHex: string;
  walletPublicKeyHex?: string;
  minerFeeSats?: number;
  feeRateSatPerVb?: number;
  feeTier?: "eco" | "standard" | "priority";
  idempotencyKey: string;
  feeScriptHex: string;
};
function feeMethod(params: Common) {
  if ((params.minerFeeSats === undefined) === (params.feeRateSatPerVb === undefined))
    throw new Error("select one CRC miner fee method");
  if (
    params.minerFeeSats !== undefined &&
    (!Number.isSafeInteger(params.minerFeeSats) || params.minerFeeSats < 1)
  )
    throw new Error("invalid miner fee");
  if (
    params.feeRateSatPerVb !== undefined &&
    (!Number.isSafeInteger(params.feeRateSatPerVb) ||
      params.feeRateSatPerVb < 1 ||
      params.feeRateSatPerVb > 500)
  )
    throw new AppError("MINER_FEE_TOO_HIGH", "invalid CRC mining speed");
}
/** Mechanical upper-bound witness sizing; the core remains responsible for exact amounts/fees. */
function signedVsize(plan: core.Plan, custody?: core.GuardianCustody) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  plan.inputs.forEach((input, index) => {
    tx.addInput(
      Buffer.from(input.txid, "hex").reverse(),
      input.vout,
      0xfffffffe,
      input.redeemScriptHex
        ? bitcoin.script.compile([Buffer.from(input.redeemScriptHex, "hex")])
        : undefined,
    );
    const witness = plan.inputWitnesses?.[index];
    tx.setWitness(
      index,
      witness?.length
        ? witness.map((hex) => Buffer.from(hex, "hex"))
        : index === 0 && custody
          ? [
              Buffer.alloc(65),
              Buffer.from(custody.assetCommitmentHex, "hex"),
              Buffer.from(custody.executionScriptHex, "hex"),
              Buffer.from(custody.controlBlockHex, "hex"),
            ]
          : /^5120/.test(input.scriptHex)
            ? [Buffer.alloc(65)]
            : [Buffer.alloc(73), Buffer.alloc(33)],
    );
  });
  plan.outputs.forEach((output) =>
    tx.addOutput(Buffer.from(output.scriptHex, "hex"), Number(output.sats)),
  );
  return tx.virtualSize();
}
function selectPlan(
  params: Common,
  candidates: CrcObservedInput[],
  build: (funding: core.Input[], fee: bigint) => core.Plan,
  custody?: core.GuardianCustody,
) {
  feeMethod(params);
  let target = BigInt(params.minerFeeSats ?? 1);
  for (let attempt = 0; attempt < 42; attempt++) {
    if (target > core.maxMinerFeeSats)
      throw new AppError("MINER_FEE_TOO_HIGH", "selected mining speed exceeds the miner fee cap");
    let plan: core.Plan | undefined;
    for (let count = 0; count <= candidates.length; count++) {
      try {
        plan = build(candidates.slice(0, count), target);
        break;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "expired or unavailable offer, or missing current height"
        )
          throw new AppError("STATE_CHANGED", error.message);
        if (
          !(error instanceof Error) ||
          ![
            "insufficient BTC funding",
            "unspendable/dust output",
            "missing or duplicate input",
          ].includes(error.message)
        )
          throw error;
      }
    }
    if (!plan) throw new AppError("INSUFFICIENT_BTC", "insufficient CRC wallet funding");
    if (params.feeRateSatPerVb === undefined) return plan;
    const required = BigInt(params.feeRateSatPerVb * signedVsize(plan, custody));
    if (target >= required) return plan;
    target = required;
  }
  throw new Error("CRC fee sizing did not converge");
}
function requestHash(params: Common, values: Record<string, unknown>) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        network: params.network,
        walletScriptHex: params.walletScriptHex,
        tokenScriptHex: params.tokenScriptHex,
        walletPublicKeyHex: params.walletPublicKeyHex,
        minerFeeSats: params.minerFeeSats,
        feeRateSatPerVb: params.feeRateSatPerVb,
        feeTier: params.feeTier,
        feeScriptHex: params.feeScriptHex,
        ...values,
      }),
    )
    .digest("hex");
}
async function replayBuild(params: Common, hash: string) {
  const session = await findCrcBuildSessionByKey(params.db, params.network, params.idempotencyKey);
  if (!session) return null;
  if (
    session.requestHash !== hash ||
    session.walletScriptHex !== params.walletScriptHex ||
    session.tokenScriptHex !== params.tokenScriptHex
  )
    throw new AppError(
      "IDEMPOTENCY_CONFLICT",
      "CRC idempotency key already belongs to a different request",
    );
  return {
    sessionId: session.id,
    psbtBase64: session.psbtBase64,
    intent: session.trustedJson as Record<string, unknown>,
  };
}
function publicKeys(plan: core.Plan, candidates: CrcObservedInput[]) {
  const byKey = new Map(
    candidates
      .filter((input) => input.publicKeyHex)
      .map((input) => [core.outpoint(input), input.publicKeyHex!]),
  );
  return Object.fromEntries(
    plan.inputs.flatMap((input, index) =>
      byKey.has(core.outpoint(input)) ? [[index, byKey.get(core.outpoint(input))!]] : [],
    ),
  );
}
export async function buildCrcLaunchSession(
  params: Common & {
    ticker: string;
    metadata?: CrcLaunchMetadata;
    funding: CrcFundingOutpoint[];
    guardianXOnly: Buffer;
    recoveryProfile: VaultRecoveryProfile;
  },
) {
  const metadata = parseCrcLaunchMetadata(params.metadata, params.ticker);
  const hash = requestHash(params, {
    ticker: params.ticker,
    metadata,
    funding: params.funding,
    guardianXOnly: params.guardianXOnly.toString("hex"),
    recoveryProfile: {
      version: params.recoveryProfile.profileVersion,
      csv: params.recoveryProfile.recoveryCsvBlocks,
      threshold: params.recoveryProfile.recoveryThreshold,
      keys: params.recoveryProfile.recoveryPubkeys.map((key) => key.toString("hex")),
    },
  });
  const existing = await replayBuild(params, hash);
  if (existing) return existing;
  const launchSalt = randomBytes(32);
  const identity = {
    deploymentTag: crc20DeploymentTag(Buffer.from(core.deployMarker(params.ticker))),
    launchSalt,
  };
  const vault = buildCrc20AssetVault({
    asset: identity,
    guardianXOnly: params.guardianXOnly,
    recoveryProfile: params.recoveryProfile,
    network: params.bitcoinNetwork,
  });
  const config = core.guardianConfig(
    {
      network: core.protocolNetwork(params.network),
      ticker: params.ticker,
      vaultScriptHex: vault.scriptPubKey.toString("hex"),
      creatorScriptHex: params.walletScriptHex,
      protocolScriptHex: params.feeScriptHex,
    },
    {
      assetCommitmentHex: crc20AssetCommitment(identity).toString("hex"),
      guardianPublicKeyHex: params.guardianXOnly.toString("hex"),
      executionScriptHex: vault.executionLeaf.script.toString("hex"),
      controlBlockHex: vault.executionControlBlock.toString("hex"),
      recoveryLeafHashHex: vault.recoveryLeaf.tapleafHash.toString("hex"),
    },
  );
  const candidates = await loadCrcFundingCandidates(
    params.db,
    params.network,
    params.walletScriptHex,
    params.funding,
    { publicKeyHex: params.walletPublicKeyHex },
  );
  const plan = selectPlan(params, candidates, (funding, minerFeeSats) =>
    core.buildDeploy({ config, funding, minerFeeSats, changeScriptHex: params.walletScriptHex }),
  );
  const psbt = createPlanPsbt(plan, params.network, { publicKeys: publicKeys(plan, candidates) });
  const digest = unsignedTxDigest(psbt);
  const intent = {
    operation: "deploy" as const,
    ticker: params.ticker,
    metadata,
    vaultScriptHex: config.vaultScriptHex,
    creatorScriptHex: config.creatorScriptHex,
    protocolScriptHex: config.protocolScriptHex,
    vaultAnchorSats: Number(core.carrierSats),
    creatorRecordSats: Number(core.carrierSats),
    launchFeeSats: Number(core.launchFeeSats),
    minerFeeSats: Number(plan.minerFeeSats),
    feeRateSatPerVb: params.feeRateSatPerVb ?? null,
    feeTier: params.feeTier ?? null,
    changeSats: Number(plan.outputs.find((output) => output.role === "btcChange")?.sats ?? 0n),
    unsignedTxDigest: digest,
    launchSaltHex: launchSalt.toString("hex"),
    coreConfig: core.encodeProtocolDto(config),
    corePlan: core.encodeProtocolDto(plan),
  };
  const session = await createCrcBuildSession(params.db, {
    network: params.network,
    operation: "deploy",
    deploymentTxid: null,
    idempotencyKey: params.idempotencyKey,
    requestHash: hash,
    unsignedTxDigest: digest,
    psbtBase64: psbt.toBase64(),
    walletScriptHex: params.walletScriptHex,
    tokenScriptHex: params.tokenScriptHex,
    trustedJson: intent,
  });
  return {
    sessionId: session.id,
    psbtBase64: session.psbtBase64,
    intent: session.trustedJson as typeof intent,
  };
}
export async function buildCrcTradeSession(
  params: Common & {
    asset: { assetId: string; deployTxid: string };
    operation: "buy" | "sell";
    amountAtoms: bigint;
    tokenPublicKeyHex?: string;
    sellerFunding?: CrcFundingOutpoint[];
    paymentFunding: CrcFundingOutpoint[];
  },
) {
  const hash = requestHash(params, {
    assetId: params.asset.assetId,
    operation: params.operation,
    amountAtoms: params.amountAtoms.toString(),
    sellerFunding: params.sellerFunding,
    paymentFunding: params.paymentFunding,
    tokenPublicKeyHex: params.tokenPublicKeyHex,
  });
  const existing = await replayBuild(params, hash);
  if (existing) return existing;
  const ledger = await loadCrcCoreLedger(params.db, params.network);
  const state = ledger?.assets[params.asset.deployTxid];
  if (
    !state ||
    params.asset.assetId !== `${params.network}:${state.deployTxid}` ||
    state.config.protocolScriptHex !== params.feeScriptHex
  )
    throw new Error("CRC asset does not match trusted launch configuration");
  const asset: CrcQuoteAsset = {
    ...params.asset,
    mintedAtoms: state.issuedAtoms.toString(),
    inventoryAtoms: state.inventoryAtoms.toString(),
    circulatingAtoms: (state.issuedAtoms - state.inventoryAtoms - state.burnedAtoms).toString(),
    vaultAnchorSats: core.carrierSats.toString(),
    vault: {
      txid: state.vault.txid,
      vout: state.vault.vout,
      btcSats: core.sats(state.vault.sats).toString(),
    },
    coreState: core.encodeProtocolDto(state),
    availability: state.vaultAvailable === false ? ("unavailable" as const) : ("active" as const),
  };
  const quote =
    params.operation === "sell"
      ? quoteCrcSell(asset, params.amountAtoms, params.tokenScriptHex)
      : quoteCrcBuy(asset, params.amountAtoms);
  const tokens: CrcObservedInput[] =
    params.operation === "sell"
      ? (params.sellerFunding ?? []).map((input) => {
          const allocation = ledger!.allocations[core.outpoint(input)];
          if (
            !allocation ||
            allocation.deployTxid !== state.deployTxid ||
            allocation.scriptHex !== params.tokenScriptHex
          )
            throw new AppError("FUNDING_INPUT_INVALID", "indexed token owner or asset mismatch");
          return {
            ...input,
            ...allocation,
            ...crcWalletMetadata(allocation.scriptHex, params.tokenPublicKeyHex),
          };
        })
      : [];
  const candidates = await loadCrcFundingCandidates(
    params.db,
    params.network,
    params.walletScriptHex,
    params.paymentFunding,
    { publicKeyHex: params.walletPublicKeyHex },
  );
  const plan = selectPlan(
    params,
    candidates,
    (funding, minerFeeSats) =>
      params.operation === "sell"
        ? core.buildSell({
            state,
            inputs: tokens,
            funding,
            amountAtoms: params.amountAtoms,
            recipientScriptHex: params.tokenScriptHex,
            changeScriptHex: params.walletScriptHex,
            minerFeeSats,
          })
        : core.buildBuy({
            state,
            funding,
            amountAtoms: params.amountAtoms,
            recipientScriptHex: params.tokenScriptHex,
            changeScriptHex: params.walletScriptHex,
            minerFeeSats,
          }),
    state.config.guardianCustody,
  );
  const psbt = createPlanPsbt(plan, params.network, {
    publicKeys: publicKeys(plan, [...tokens, ...candidates]),
  });
  const digest = unsignedTxDigest(psbt);
  const buy = params.operation === "buy" ? describeCurveBuy(state, params.amountAtoms) : undefined;
  const operation = buy?.operation ?? "sell";
  const intent = {
    operation,
    assetId: params.asset.assetId,
    amountAtoms: params.amountAtoms.toString(),
    ...(buy
      ? {
          inventoryBuyAtoms: buy.inventoryBuyAtoms.toString(),
          newlyMintedAtoms: buy.newlyMintedAtoms.toString(),
        }
      : {}),
    vaultOutpoint: core.outpoint(state.vault),
    walletScriptHex: params.walletScriptHex,
    tokenScriptHex: params.tokenScriptHex,
    minerFeeSats: Number(plan.minerFeeSats),
    feeRateSatPerVb: params.feeRateSatPerVb ?? null,
    feeTier: params.feeTier ?? null,
    changeSats: Number(plan.outputs.find((output) => output.role === "btcChange")?.sats ?? 0n),
    unsignedTxDigest: digest,
    quote,
    corePlan: core.encodeProtocolDto(plan),
    coreConfig: core.encodeProtocolDto(state.config),
  };
  const session = await createCrcBuildSession(params.db, {
    network: params.network,
    operation,
    deploymentTxid: state.deployTxid,
    idempotencyKey: params.idempotencyKey,
    requestHash: hash,
    unsignedTxDigest: digest,
    psbtBase64: psbt.toBase64(),
    walletScriptHex: params.walletScriptHex,
    tokenScriptHex: params.tokenScriptHex,
    trustedJson: intent,
  });
  return {
    sessionId: session.id,
    psbtBase64: session.psbtBase64,
    intent: session.trustedJson as typeof intent,
  };
}

export async function buildCrcTokenSession(
  params: Common & {
    deployTxid: string;
    operation: "transfer" | "listing";
    amountAtoms: bigint;
    recipientScriptHex: string;
    priceSats?: bigint;
    tokenFunding: CrcFundingOutpoint[];
    paymentFunding: CrcFundingOutpoint[];
    tokenPublicKeyHex?: string;
  },
) {
  const hash = requestHash(params, {
    deployTxid: params.deployTxid,
    operation: params.operation,
    amountAtoms: params.amountAtoms.toString(),
    recipientScriptHex: params.recipientScriptHex,
    priceSats: params.priceSats?.toString(),
    tokenFunding: params.tokenFunding,
    paymentFunding: params.paymentFunding,
    tokenPublicKeyHex: params.tokenPublicKeyHex,
  });
  const existing = await replayBuild(params, hash);
  if (existing) return existing;
  const ledger = await loadCrcCoreLedger(params.db, params.network);
  const asset = ledger?.assets[params.deployTxid];
  if (!asset || asset.config.protocolScriptHex !== params.feeScriptHex)
    throw new AppError("STATE_CHANGED", "CRC asset registration is unavailable");
  if (!params.tokenFunding.length || params.tokenFunding.length > 32)
    throw new AppError("FUNDING_INPUT_INVALID", "Select one to 32 indexed token inputs");
  const tokens: CrcObservedInput[] = params.tokenFunding.map((input) => {
    const allocation = ledger!.allocations[core.outpoint(input)];
    if (
      !allocation ||
      allocation.deployTxid !== asset.deployTxid ||
      allocation.scriptHex !== params.tokenScriptHex
    )
      throw new AppError("FUNDING_INPUT_INVALID", "Indexed token owner or asset mismatch");
    return {
      ...input,
      ...allocation,
      ...crcWalletMetadata(allocation.scriptHex, params.tokenPublicKeyHex),
    };
  });
  const candidates = await loadCrcFundingCandidates(
    params.db,
    params.network,
    params.walletScriptHex,
    params.paymentFunding,
    { publicKeyHex: params.walletPublicKeyHex },
  );
  const plan = selectPlan(params, candidates, (funding, minerFeeSats) =>
    (params.operation === "listing" ? core.buildListing : core.buildTransfer)({
      network: asset.config.network,
      deployTxid: asset.deployTxid,
      ticker: asset.config.ticker,
      inputs: tokens,
      funding,
      amountAtoms: params.amountAtoms,
      recipientScriptHex: params.recipientScriptHex,
      sellerScriptHex: params.tokenScriptHex,
      changeScriptHex: params.walletScriptHex,
      minerFeeSats,
      priceSats: params.priceSats,
    }),
  );
  const psbt = createPlanPsbt(plan, params.network, {
    publicKeys: publicKeys(plan, [...tokens, ...candidates]),
  });
  const digest = unsignedTxDigest(psbt);
  const intent = {
    operation: params.operation,
    assetId: `${params.network}:${asset.deployTxid}`,
    amountAtoms: params.amountAtoms.toString(),
    recipientScriptHex: params.recipientScriptHex,
    priceSats: params.priceSats?.toString(),
    walletScriptHex: params.walletScriptHex,
    tokenScriptHex: params.tokenScriptHex,
    minerFeeSats: Number(plan.minerFeeSats),
    unsignedTxDigest: digest,
    corePlan: core.encodeProtocolDto(plan),
    coreConfig: core.encodeProtocolDto(asset.config),
  };
  const session = await createCrcBuildSession(params.db, {
    network: params.network,
    operation: params.operation,
    deploymentTxid: asset.deployTxid,
    idempotencyKey: params.idempotencyKey,
    requestHash: hash,
    unsignedTxDigest: digest,
    psbtBase64: psbt.toBase64(),
    walletScriptHex: params.walletScriptHex,
    tokenScriptHex: params.tokenScriptHex,
    trustedJson: intent,
  });
  return {
    sessionId: session.id,
    psbtBase64: session.psbtBase64,
    intent: session.trustedJson as typeof intent,
  };
}

export async function buildCrcOfferSession(
  params: Common & {
    offerId: string;
    operation: "purchase" | "cancel";
    paymentFunding: CrcFundingOutpoint[];
    tokenPublicKeyHex?: string;
  },
) {
  const hash = requestHash(params, {
    operation: params.operation,
    offerId: params.offerId,
    paymentFunding: params.paymentFunding,
    tokenPublicKeyHex: params.tokenPublicKeyHex,
  });
  const existing = await replayBuild(params, hash);
  if (existing) return existing;
  const ledger = await loadCrcCoreLedger(params.db, params.network);
  const offer = ledger?.offers[params.offerId],
    asset = offer && ledger?.assets[offer.deployTxid];
  if (!offer || !asset || asset.config.protocolScriptHex !== params.feeScriptHex)
    throw new AppError("STATE_CHANGED", "CRC signed offer is unavailable");
  if (params.operation === "cancel" && offer.sellerScriptHex !== params.tokenScriptHex)
    throw new AppError("CLIENT_INTENT_MISMATCH", "Cancellation must use the offer owner");
  const candidates = await loadCrcFundingCandidates(
    params.db,
    params.network,
    params.walletScriptHex,
    params.paymentFunding,
    { publicKeyHex: params.walletPublicKeyHex },
  );
  const plan = selectPlan(params, candidates, (funding, minerFeeSats) =>
    params.operation === "purchase"
      ? core.buildPurchase({
          offer,
          currentHeight: ledger!.tip?.height ?? 0,
          buyerFunding: funding,
          buyerScriptHex: params.tokenScriptHex,
          protocolScriptHex: asset.config.protocolScriptHex,
          changeScriptHex: params.walletScriptHex,
          minerFeeSats,
        })
      : core.buildCancel({ offer, funding, changeScriptHex: params.walletScriptHex, minerFeeSats }),
  );
  const inputs =
    params.operation === "cancel"
      ? [
          {
            ...offer.listedInput,
            ...crcWalletMetadata(offer.sellerScriptHex, params.tokenPublicKeyHex),
          },
          ...candidates,
        ]
      : candidates;
  const psbt = createPlanPsbt(plan, params.network, { publicKeys: publicKeys(plan, inputs) });
  const digest = unsignedTxDigest(psbt);
  const intent = {
    operation: params.operation,
    offerId: params.offerId,
    assetId: `${params.network}:${asset.deployTxid}`,
    walletScriptHex: params.walletScriptHex,
    tokenScriptHex: params.tokenScriptHex,
    amountAtoms: offer.listedInput.atoms.toString(),
    minerFeeSats: Number(plan.minerFeeSats),
    unsignedTxDigest: digest,
    corePlan: core.encodeProtocolDto(plan),
    coreConfig: core.encodeProtocolDto(asset.config),
  };
  const session = await createCrcBuildSession(params.db, {
    network: params.network,
    operation: params.operation,
    deploymentTxid: asset.deployTxid,
    idempotencyKey: params.idempotencyKey,
    requestHash: hash,
    unsignedTxDigest: digest,
    psbtBase64: psbt.toBase64(),
    walletScriptHex: params.walletScriptHex,
    tokenScriptHex: params.tokenScriptHex,
    trustedJson: intent,
  });
  return {
    sessionId: session.id,
    psbtBase64: session.psbtBase64,
    intent: session.trustedJson as typeof intent,
  };
}
