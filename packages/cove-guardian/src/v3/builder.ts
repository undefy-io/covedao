import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { psbtInputFor } from "@crclaunch/bitcoin";
import {
  TOKEN_CARRIER_SATS,
  applyMintV2,
  applyRedeemV2,
  s0StateV2,
  type CoveStateV2,
} from "@crclaunch/cove-covenant";
import { buildBackingVaultV3, type CoveVaultV3, type VaultRecoveryProfile } from "@crclaunch/cove-vault";
import {
  COVE_POLICY_V3,
  computeTokenId,
  encodeDeployV2,
  encodeMintV2,
  encodeDiscovery,
  decodeV2,
  encodeRedeemV2,
  encodeTransferV2,
  type TokenIdentityInput,
} from "@crclaunch/cove-wire";
import { grossBuy } from "@crclaunch/cove-economics";
import { mintFeeSats, redeemFeeSats as redeemFeeOf, creatorFeeSats, CREATOR_RECORD_SATS, LAUNCH_FEE_SATS, dustThreshold, COVE_FEE_CONFIG } from "@crclaunch/cove-economics";
import type { Sats } from "@crclaunch/curve";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

/** Fixed non-reserve satoshi anchor carried by every backing state UTXO. */
export const RESERVE_ANCHOR_SATS = 10_000n;

/**
 * Add a change output, or fold change too small to stand alone into the miner
 * fee — and report the fee that results.
 *
 * Bitcoin will not relay an output below the dust threshold, so change in
 * (0, dust) cannot be paid out; it necessarily becomes miner fee. The caller
 * MUST use the returned figure as the transaction's miner fee: the browser
 * re-derives the fee from inputs minus outputs and refuses to sign when it
 * disagrees with the stated one, so quietly absorbing sats here used to make
 * the trade fail with an error nobody could act on.
 *
 * The amount absorbed is bounded by the dust threshold (at most 329 sats for
 * any standard script), and it is disclosed rather than hidden.
 */
function addChangeOrAbsorb(
  psbt: bitcoin.Psbt,
  changeScript: Buffer,
  changeSats: Sats,
  minerFeeSats: Sats,
): { minerFeeSats: Sats; changeSats: Sats; absorbedSats: Sats } {
  if (changeSats <= 0n) return { minerFeeSats, changeSats: 0n, absorbedSats: 0n };
  if (changeSats >= dustThreshold(changeScript)) {
    psbt.addOutput({ script: changeScript, value: Number(changeSats) });
    return { minerFeeSats, changeSats, absorbedSats: 0n };
  }
  return { minerFeeSats: minerFeeSats + changeSats, changeSats: 0n, absorbedSats: changeSats };
}

export interface ResolvedInput {
  txid: string;
  vout: number;
  script: Buffer;
  valueSats: Sats;
  /**
   * The owner's public key.
   *
   * Optional only because a native-segwit input does not need it. A nested
   * segwit input needs its redeemScript and a Taproot input needs its internal
   * key, and neither can be recovered from the scriptPubKey — omit it for
   * those and the wallet is handed an input it will silently decline to sign.
   */
  publicKey?: Buffer;
}

export interface DeployResult {
  psbt: bitcoin.Psbt;
  tokenId: Buffer;
  s0: CoveStateV2;
  vault: CoveVaultV3;
  wire: Buffer;
  /** The fee actually paid, including any change too small to be an output. */
  minerFeeSats: Sats;
}

/**
 * Build a real DEPLOY PSBT (§8). Canonical outputs: [0] OP_RETURN (wire v2
 * DEPLOY), [1] S0 backing vault (RESERVE_ANCHOR_SATS, backing=0), [2] creator
 * record (CREATOR_RECORD_SATS), [3] launch fee (LAUNCH_FEE_SATS to the protocol
 * fee address), [4] deployer change if any. tokenId is derived
 * pre-transaction (never the txid) and commits to the creator script.
 */
export function buildDeployPsbtV3(params: {
  network: bitcoin.networks.Network;
  /** The token identity; the creator script is taken from `creatorScript` below. */
  identity: Omit<TokenIdentityInput, "creatorScript">;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  deployerInputs: ResolvedInput[];
  deployerChangeScript: Buffer;
  /** Where the creator's share of every mint is paid. Defaults to the deployer's change script. */
  creatorScript?: Buffer;
  /** The protocol fee address; output 3 pays it the launch fee. */
  feeScript: Buffer;
  minerFeeSats: Sats;
}): DeployResult {
  const creatorScript = params.creatorScript ?? params.deployerChangeScript;
  const tokenId = computeTokenId({ ...params.identity, creatorScript });
  const tokenIdHex = tokenId.toString("hex");
  const s0 = s0StateV2({ tokenId: tokenIdHex });
  const vault = buildBackingVaultV3({
    state: s0,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
      recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  const wire = encodeDeployV2({
    policyVersion: COVE_POLICY_V3,
    ticker: params.identity.ticker,
    tokenNonce: params.identity.tokenNonce,
  });

  const psbt = new bitcoin.Psbt({ network: params.network });
  for (const input of params.deployerInputs) {
    psbt.addInput(psbtInputFor(input, params.network));
  }
  psbt.addOutput({ script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]), value: 0 });
  psbt.addOutput({ script: vault.scriptPubKey, value: Number(RESERVE_ANCHOR_SATS) });
  // Output 2 records the creator: every mint pays their share to this script.
  psbt.addOutput({ script: creatorScript, value: Number(CREATOR_RECORD_SATS) });
  // Output 3 pays the launch fee; the indexer refuses a DEPLOY without it.
  psbt.addOutput({ script: params.feeScript, value: Number(LAUNCH_FEE_SATS) });

  const totalIn = params.deployerInputs.reduce((s, i) => s + i.valueSats, 0n);
  const change = totalIn - RESERVE_ANCHOR_SATS - CREATOR_RECORD_SATS - LAUNCH_FEE_SATS - params.minerFeeSats;
  if (change < 0n) throw new Error("insufficient deployer funds");
  const settled = addChangeOrAbsorb(psbt, params.deployerChangeScript, change, params.minerFeeSats);

  return { psbt, tokenId, s0, vault, wire, minerFeeSats: settled.minerFeeSats };
}

export interface MintResult {
  psbt: bitcoin.Psbt;
  prevVault: CoveVaultV3;
  nextState: CoveStateV2;
  nextVault: CoveVaultV3;
  grossSats: Sats;
  buyFeeSats: Sats;
  creatorFeeSats: Sats;
  wire: Buffer;
  stateInputIndex: number;
  /** The fee actually paid, including any change too small to be an output. */
  minerFeeSats: Sats;
}

/**
 * Build a real MINT/backing-buy PSBT (§9). Canonical outputs: [0] OP_RETURN,
 * [1] successor backing vault, [2] buyer token carrier, [3] Cove buy fee,
 * [4] creator's share, [5] buyer BTC change. The state input (index 0) is signed script-path by the
 * Guardian; the buyer funds BTC + carrier sats + fee + miner fee.
 */
export function buildMintPsbtV3(params: {
  network: bitcoin.networks.Network;
  tokenId: Buffer;
  prevState: CoveStateV2;
  prevBacking: ResolvedInput; // { txid, vout, script: vault.scriptPubKey, valueSats }
  mintAmountAtoms: bigint;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  buyerInputs: ResolvedInput[];
  buyerCarrierScript: Buffer; // buyer token carrier output script
  buyerChangeScript: Buffer;
  feeScript: Buffer; // Cove protocol fee destination
  /** The token's creator, recorded at DEPLOY; paid their share at vout 4. */
  creatorScript: Buffer;
  /** Creator share, bps of the curve price. Defaults to COVE_FEE_CONFIG. */
  creatorFeeBps?: bigint;
  minerFeeSats: Sats;
  /** Protocol fee schedule (bps). Defaults to the development COVE_FEE_CONFIG. */
  buyFeeBps?: bigint;
  /** Flat sats added on top of the percentage. */
  buyFeeFlatSats?: bigint;
  /**
   * Emit the advisory `crc-20` discovery envelope as a trailing OP_RETURN
   * (§D1). OPT-IN: it needs two OP_RETURNs in one transaction, which Bitcoin
   * Core rejects as `multi-op-return` before v30 relaxed the datacarrier
   * policy. Leave it off for a deployment that must relay through older nodes.
   */
  discoveryEnvelope?: { ticker: string };
}): MintResult {
  const { nextState, grossSats } = applyMintV2(params.prevState, params.mintAmountAtoms);
  const prevVault = buildBackingVaultV3({
    state: params.prevState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
      recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  const nextVault = buildBackingVaultV3({
    state: nextState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
      recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  const buyFeeSats = mintFeeSats(grossSats, params.mintAmountAtoms, params.buyFeeBps ?? COVE_FEE_CONFIG.buyFeeBps, params.buyFeeFlatSats ?? COVE_FEE_CONFIG.buyFeeFlatSats);
  const wire = encodeMintV2({
    tokenId: params.tokenId,
    amount: params.mintAmountAtoms,
    recipientVout: 2,
  });

  const psbt = new bitcoin.Psbt({ network: params.network });
  psbt.addInput({
    hash: params.prevBacking.txid,
    index: params.prevBacking.vout,
    witnessUtxo: { script: params.prevBacking.script, value: Number(params.prevBacking.valueSats) },
    tapInternalKey: prevVault.numsKey,
    tapMerkleRoot: prevVault.merkleRoot,
    tapLeafScript: [
      {
        leafVersion: 0xc0,
        script: prevVault.mintLeaf.script,
        controlBlock: prevVault.mintControlBlock,
      },
    ],
  });
  for (const input of params.buyerInputs) {
    psbt.addInput(psbtInputFor(input, params.network));
  }

  psbt.addOutput({ script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]), value: 0 });
  psbt.addOutput({
    script: nextVault.scriptPubKey,
    value: Number(RESERVE_ANCHOR_SATS + nextState.backingSats),
  });
  psbt.addOutput({ script: params.buyerCarrierScript, value: Number(TOKEN_CARRIER_SATS) });
  psbt.addOutput({ script: params.feeScript, value: Number(buyFeeSats) });
  const creatorFee = creatorFeeSats(grossSats, params.creatorFeeBps ?? COVE_FEE_CONFIG.creatorFeeBps);
  psbt.addOutput({ script: params.creatorScript, value: Number(creatorFee) });

  const totalIn =
    params.prevBacking.valueSats + params.buyerInputs.reduce((s, i) => s + i.valueSats, 0n);
  const change =
    totalIn -
    (RESERVE_ANCHOR_SATS + nextState.backingSats) -
    TOKEN_CARRIER_SATS -
    buyFeeSats -
    creatorFee -
    params.minerFeeSats;
  if (change < 0n) throw new Error("insufficient buyer funds");
  const settled = addChangeOrAbsorb(psbt, params.buyerChangeScript, change, params.minerFeeSats);

  // Advisory crc-20 discovery envelope, ALWAYS last so every fixed-index output
  // check above is unaffected. Derived from the same binary envelope the
  // validator re-derives, so the two can never disagree.
  if (params.discoveryEnvelope) {
    const discovery = encodeDiscovery(decodeV2(wire), params.discoveryEnvelope.ticker);
    psbt.addOutput({
      script: Buffer.concat([Buffer.from([0x6a, discovery.length]), discovery]),
      value: 0,
    });
  }

  return {
    psbt,
    prevVault,
    nextState,
    nextVault,
    grossSats,
    buyFeeSats,
    creatorFeeSats: creatorFee,
    wire,
    stateInputIndex: 0,
    minerFeeSats: settled.minerFeeSats,
  };
}

export interface TransferResult {
  psbt: bitcoin.Psbt;
  wire: Buffer;
  /** wire-v2 TRANSFER allocations, keyed by FINAL output vout. */
  allocations: { vout: number; amount: bigint }[];
  /** Token carrier outputs actually created (vout, script, amount). */
  tokenOutputs: { vout: number; script: Buffer; amountAtoms: bigint }[];
  /** The fee actually paid, including any change too small to be an output. */
  minerFeeSats: Sats;
}

/**
 * Build a real TRANSFER PSBT (§10). Ordinary Bitcoin — no backing, no Guardian.
 * Canonical outputs: [0] OP_RETURN (wire v2 TRANSFER), [1..n] token carrier
 * outputs (one per allocation), then any BTC outputs (e.g. P2P payment + fee),
 * then funder change. Token conservation is enforced here and re-verified by the
 * resolver. Backing/supply are NOT touched by a transfer.
 */
export function buildTransferPsbtV2(params: {
  network: bitcoin.networks.Network;
  tokenId: Buffer;
  tokenInputs: ResolvedInput[];
  /** Sum of token amounts (atoms) on tokenInputs, resolved from the chain view. */
  tokenInputTotalAtoms: bigint;
  /** Token outputs (recipient + change); sum must equal tokenInputTotalAtoms. */
  tokenOutputs: { script: Buffer; amountAtoms: bigint }[];
  /** Ordinary BTC inputs funding carriers + BTC outputs + miner fee. */
  funderInputs: ResolvedInput[];
  funderChangeScript: Buffer;
  /** BTC outputs in addition to the carrier outputs (P2P payment, p2p fee, …). */
  btcOutputs: { script: Buffer; valueSats: Sats }[];
  minerFeeSats: Sats;
}): TransferResult {
  if (params.tokenOutputs.length === 0) throw new Error("no token outputs");
  if (params.tokenOutputs.length > 4) throw new Error("max 4 token outputs");
  const tokenOutTotal = params.tokenOutputs.reduce((s, o) => s + o.amountAtoms, 0n);
  if (tokenOutTotal !== params.tokenInputTotalAtoms)
    throw new Error(
      `token conservation violated: in=${params.tokenInputTotalAtoms} out=${tokenOutTotal}`,
    );

  let vout = 0;
  const wire = encodeTransferV2({
    tokenId: params.tokenId,
    allocations: params.tokenOutputs.map((o) => ({ vout: ++vout, amount: o.amountAtoms })),
  });

  const psbt = new bitcoin.Psbt({ network: params.network });
  for (const input of [...params.tokenInputs, ...params.funderInputs]) {
    psbt.addInput(psbtInputFor(input, params.network));
  }

  psbt.addOutput({ script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]), value: 0 });
  const tokenOutputs: TransferResult["tokenOutputs"] = [];
  for (const o of params.tokenOutputs) {
    tokenOutputs.push({ vout: psbt.txOutputs.length, script: o.script, amountAtoms: o.amountAtoms });
    psbt.addOutput({ script: o.script, value: Number(TOKEN_CARRIER_SATS) });
  }
  for (const o of params.btcOutputs) {
    psbt.addOutput({ script: o.script, value: Number(o.valueSats) });
  }

  const totalIn = [...params.tokenInputs, ...params.funderInputs].reduce(
    (s, i) => s + i.valueSats,
    0n,
  );
  const carriersOut = BigInt(params.tokenOutputs.length) * TOKEN_CARRIER_SATS;
  const btcOut = params.btcOutputs.reduce((s, o) => s + o.valueSats, 0n);
  const change = totalIn - carriersOut - btcOut - params.minerFeeSats;
  if (change < 0n) throw new Error("insufficient transfer funds");
  const settled = addChangeOrAbsorb(psbt, params.funderChangeScript, change, params.minerFeeSats);

  const allocations = params.tokenOutputs.map((o, i) => ({ vout: i + 1, amount: o.amountAtoms }));
  return { psbt, wire, allocations, tokenOutputs, minerFeeSats: settled.minerFeeSats };
}

export interface RedeemResult {
  psbt: bitcoin.Psbt;
  prevVault: CoveVaultV3;
  nextState: CoveStateV2;
  nextVault: CoveVaultV3;
  grossSats: Sats;
  redeemFeeSats: Sats;
  netSats: Sats;
  payoutSats: Sats;
  changeAtoms: bigint;
  wire: Buffer;
  /** The fee actually paid, including any change too small to be an output. */
  minerFeeSats: Sats;
}

/**
 * Build a real REDEEM PSBT (§11). Script-path REDEEM execution leaf (analogous
 * to MINT). Canonical outputs: [0] OP_RETURN (wire v2 REDEEM), [1] successor
 * backing vault, [2] seller BTC payout, [3] Cove redeem fee,
 * [4] token change carrier (only if partial redeem), [5] seller BTC change.
 */
export function buildRedeemPsbtV3(params: {
  network: bitcoin.networks.Network;
  tokenId: Buffer;
  prevState: CoveStateV2;
  prevBacking: ResolvedInput;
  redeemAmountAtoms: bigint;
  tokenInputs: ResolvedInput[];
  tokenInputTotalAtoms: bigint;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  sellerPayoutScript: Buffer;
  sellerChangeScript: Buffer;
  feeScript: Buffer;
  minerFeeSats: Sats;
  /**
   * Ordinary BTC inputs funding the miner fee.
   *
   * Without these the miner fee can only come from the seller's token carriers,
   * which are 1,000 sats each. That gave redeem a hard fee ceiling of roughly
   * `carriers × 1000` and made a partial redeem from a single carrier
   * arithmetically impossible (1000 − 1000 change carrier − fee < 0). The
   * backing vault must never pay the miner fee, so the seller funds it like any
   * other spender.
   */
  funderInputs?: ResolvedInput[];
  /** Where BTC change goes; defaults to the seller's change script. */
  funderChangeScript?: Buffer;
  /** Protocol fee schedule (bps). Defaults to the development COVE_FEE_CONFIG. */
  redeemFeeBps?: bigint;
  /** Flat sats deducted on top of the percentage. */
  redeemFeeFlatSats?: bigint;
  /** Merge payout and BTC change, funding fees from the seller wallet. Legacy standalone settlement is retained by default. */
  walletFundedFees?: boolean;
}): RedeemResult {
  const { nextState, grossSats } = applyRedeemV2(params.prevState, params.redeemAmountAtoms);
  const prevVault = buildBackingVaultV3({
    state: params.prevState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
      recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  const nextVault = buildBackingVaultV3({
    state: nextState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
      recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  const redeemFeeSats = redeemFeeOf(grossSats, params.redeemFeeBps ?? COVE_FEE_CONFIG.redeemFeeBps, params.redeemFeeFlatSats ?? COVE_FEE_CONFIG.redeemFeeFlatSats);
  const netSats = grossSats - redeemFeeSats;
  const changeAtoms = params.tokenInputTotalAtoms - params.redeemAmountAtoms;
  if (changeAtoms < 0n) throw new Error("redeem exceeds token input");

  const changeCarrierVout = 4; // [0] OP_RETURN, [1] vault, [2] payout, [3] fee, [4] change carrier
  const wire = encodeRedeemV2({
    tokenId: params.tokenId,
    redeemAmount: params.redeemAmountAtoms,
    changeAllocations: changeAtoms > 0n ? [{ vout: changeCarrierVout, amount: changeAtoms }] : [],
  });

  const psbt = new bitcoin.Psbt({ network: params.network });
  psbt.addInput({
    hash: params.prevBacking.txid,
    index: params.prevBacking.vout,
    witnessUtxo: { script: params.prevBacking.script, value: Number(params.prevBacking.valueSats) },
    tapInternalKey: prevVault.numsKey,
    tapMerkleRoot: prevVault.merkleRoot,
    tapLeafScript: [
      {
        leafVersion: 0xc0,
        script: prevVault.redeemLeaf.script,
        controlBlock: prevVault.redeemControlBlock,
      },
    ],
  });
  for (const input of params.tokenInputs) {
    psbt.addInput(psbtInputFor(input, params.network));
  }
  // Funder inputs go last so every token-carrier index stays where the wire
  // envelope and the validator expect it.
  for (const input of params.funderInputs ?? []) {
    psbt.addInput(psbtInputFor(input, params.network));
  }

  psbt.addOutput({ script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]), value: 0 });
  psbt.addOutput({
    script: nextVault.scriptPubKey,
    value: Number(RESERVE_ANCHOR_SATS + nextState.backingSats),
  });
  const funderTotal = (params.funderInputs ?? []).reduce((s, i) => s + i.valueSats, 0n);
  const totalIn = params.prevBacking.valueSats + params.tokenInputs.reduce((s, i) => s + i.valueSats, 0n) + funderTotal;
  const successorValue = RESERVE_ANCHOR_SATS + nextState.backingSats;
  const changeCarrierValue = changeAtoms > 0n ? TOKEN_CARRIER_SATS : 0n;
  const payoutSats = params.walletFundedFees
    ? totalIn - successorValue - redeemFeeSats - changeCarrierValue - params.minerFeeSats
    : netSats;
  if (params.walletFundedFees &&
      (payoutSats < grossSats || payoutSats < dustThreshold(params.sellerPayoutScript)))
    throw new Error("insufficient redeem funds; add a BTC funding input to pay fees and return standard BTC change");
  if (params.walletFundedFees && params.funderChangeScript && !params.funderChangeScript.equals(params.sellerPayoutScript))
    throw new Error("wallet-funded redeem must return BTC change to the payout address");
  psbt.addOutput({ script: params.sellerPayoutScript, value: Number(payoutSats) });
  psbt.addOutput({ script: params.feeScript, value: Number(redeemFeeSats) });
  if (changeAtoms > 0n)
    psbt.addOutput({ script: params.sellerChangeScript, value: Number(TOKEN_CARRIER_SATS) });
  const change = totalIn - successorValue - payoutSats - redeemFeeSats - changeCarrierValue - params.minerFeeSats;
  if (change < 0n)
    throw new Error(`insufficient redeem funds: need ${-change} more sats; add a BTC funding input`);
  const settled = params.walletFundedFees ? {minerFeeSats:params.minerFeeSats} : addChangeOrAbsorb(
    psbt, params.funderChangeScript ?? params.sellerChangeScript, change, params.minerFeeSats,
  );

  return {
    psbt,
    prevVault,
    nextState,
    nextVault,
    grossSats,
    redeemFeeSats,
    payoutSats,
    netSats,
    changeAtoms,
    wire,
    minerFeeSats: settled.minerFeeSats,
  };
}

// Re-export for convenience in the lifecycle harness.
export { grossBuy, COVE_FEE_CONFIG };
