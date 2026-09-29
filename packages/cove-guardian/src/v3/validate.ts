import * as bitcoin from "bitcoinjs-lib";
import { TOKEN_CARRIER_SATS } from "@crclaunch/cove-covenant";
import { buildBackingVaultV3, type VaultRecoveryProfile } from "@crclaunch/cove-vault";
import { executeMintV3, executeRedeemV3 } from "@crclaunch/cove-simplicity";
import { COVE_FEE_CONFIG, checkFeeSettlement, isValidRedeemPayout } from "@crclaunch/cove-economics";
import { RESERVE_ANCHOR_SATS } from "./builder.js";
import { analyzeMintTransitionV3, analyzeRedeemTransitionV3, CoveAnalyzeError } from "./analyze.js";
import { buildCanonicalMintWitness, buildCanonicalRedeemWitness } from "./witness.js";
import { readPsbtOutputs, decodeCoveOpReturn } from "./resolve.js";
import { checkDiscoveryOutput } from "./discoveryOutput.js";
import type { FundingInputChecker } from "./funding.js";
import {
  type CoveCanonicalView,
  type GuardianV3Network,
  type MintAnalysis,
  type RedeemAnalysis,
  type ValidationFailureCode,
  type ValidationResult,
} from "./types.js";

/**
 * Full independent Cove transition validation (§9/§11). This is where the
 * Guardian decides VALID_TO_SIGN or refuses. It requires BOTH the real
 * Simplicity predicate PASS and the full canonical TypeScript/reference Cove
 * policy PASS (the latter includes the exact stairs210 R-delta, which the
 * Simplicity predicate intentionally does not implement).
 */

const MINT_CARRIER_VOUT = 2;
const MINT_FEE_VOUT = 3;
const MINT_CREATOR_VOUT = 4;
const REDEEM_SUCCESSOR_VOUT = 1;
const REDEEM_PAYOUT_VOUT = 2;
const REDEEM_FEE_VOUT = 3;
const REDEEM_CHANGE_CARRIER_VOUT = 4;

function reject(reason: ValidationFailureCode, detail: string): ValidationResult {
  return { ok: false, reason, detail };
}

function bitcoinNetwork(network: GuardianV3Network): bitcoin.networks.Network {
  switch (network) {
    case "regtest":
      return bitcoin.networks.regtest;
    case "mainnet":
      return bitcoin.networks.bitcoin;
    case "testnet":
      return bitcoin.networks.testnet;
    case "signet":
      return bitcoin.networks.testnet;
    default:
      throw new Error(`bad network ${String(network)}`);
  }
}

function isStandardCarrier(script: Buffer): boolean {
  const hex = script.toString("hex");
  return /^5120[0-9a-f]{64}$/.test(hex) || /^0014[0-9a-f]{40}$/.test(hex);
}

export interface ValidateParams {
  psbt: bitcoin.Psbt;
  view: CoveCanonicalView;
  network: GuardianV3Network;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  feeScript: Buffer;
  maxMinerFeeSats?: bigint;
  /** Protocol fee schedule (bps). Defaults to the development COVE_FEE_CONFIG. */
  buyFeeBps?: bigint;
  redeemFeeBps?: bigint;
  /**
   * Ticker the caller expects the advisory crc-20 discovery envelope to carry
   * (§D1). The canonical view resolves tokens by tokenId and has no ticker
   * index, so it is declared here. Omit it and a discovery envelope carrying a
   * `tick` is rejected — the payload must always be exactly the canonical
   * re-derivation, never merely plausible.
   */
  discoveryTicker?: string;
  /**
   * Checks every BTC funding input is confirmed and holds no tokens of any
   * kind (see funding.ts). Required: there is no unchecked path.
   */
  fundingChecker: FundingInputChecker;
}

/**
 * Refuse unconfirmed funding inputs and funding inputs that hold tokens. The
 * view catches carriers of the token being traded without a lookup; the
 * checker covers other Cove tokens, inscriptions, runes and confirmation.
 */
async function checkFundingInputs(
  params: ValidateParams,
  indices: number[],
): Promise<ValidationResult | null> {
  const checker = params.fundingChecker.forValidation?.() ?? params.fundingChecker;
  for (const i of indices) {
    const txIn = params.psbt.txInputs[i]!;
    const outpoint = { txid: Buffer.from(txIn.hash).reverse().toString("hex"), vout: txIn.index };
    if (params.view.getTokenUtxo(outpoint)) {
      return reject(
        "FUNDING_HOLDS_TOKEN",
        `funding input ${outpoint.txid}:${outpoint.vout} holds Cove tokens`,
      );
    }
    const prevout = params.psbt.data.inputs[i]?.witnessUtxo;
    if (!prevout)
      return reject(
        "FUNDING_PREVOUT_MISMATCH",
        `funding input ${outpoint.txid}:${outpoint.vout} has no witness UTXO`,
      );
    const verdict = await checker.check(outpoint, params.view.cursorHeight, {
      script: prevout.script,
      valueSats: BigInt(prevout.value),
    });
    if (!verdict.ok) return reject(verdict.code, verdict.detail);
  }
  return null;
}

export async function validateMintTransitionV3(params: ValidateParams): Promise<ValidationResult> {
  const maxMinerFee = params.maxMinerFeeSats ?? 20_000n;

  // Mainnet requires the MAINNET1 recovery profile (fail closed; §36).
  if (
    params.network === "mainnet" &&
    params.recoveryProfile?.profileVersion !== "COVE_V3_VAULT_PROFILE_MAINNET1"
  ) {
    return reject("MAINNET_PROFILE_REQUIRED", "mainnet requires the MAINNET1 recovery profile");
  }

  let analysis: MintAnalysis;
  try {
    analysis = analyzeMintTransitionV3(params);
  } catch (e) {
    if (e instanceof CoveAnalyzeError) return reject(e.code, e.message);
    return reject("REFERENCE_POLICY_REJECTED", (e as Error).message);
  }

  const btcNet = bitcoinNetwork(params.network);
  const prevVault = buildBackingVaultV3({
    state: analysis.currentState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: btcNet,
  });
  const nextVault = buildBackingVaultV3({
    state: analysis.nextState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: btcNet,
  });

  // ── backing input (index 0) must be the exact canonical MINT leaf ──
  const input0 = params.psbt.data.inputs[0]!;
  if (!input0.tapInternalKey || !input0.tapInternalKey.equals(prevVault.numsKey)) {
    return reject("BACKING_SCRIPT_MISMATCH", "input 0 tapInternalKey != canonical NUMS key");
  }
  if (!input0.tapMerkleRoot || !input0.tapMerkleRoot.equals(prevVault.merkleRoot)) {
    return reject("BACKING_SCRIPT_MISMATCH", "input 0 tapMerkleRoot != canonical MAST root");
  }
  const mintLeaf = input0.tapLeafScript?.[0];
  if (!mintLeaf) return reject("WRONG_LEAF", "no tap leaf script on input 0");
  if (!mintLeaf.script.equals(prevVault.mintLeaf.script)) {
    return reject("WRONG_LEAF", "input 0 leaf is not the canonical MINT execution leaf");
  }
  if (!mintLeaf.controlBlock.equals(prevVault.mintControlBlock)) {
    return reject("BAD_CONTROL_BLOCK", "input 0 control block is wrong");
  }
  const expectedPrevValue = RESERVE_ANCHOR_SATS + analysis.currentState.backingSats;
  const prevValue = BigInt(input0.witnessUtxo!.value);
  if (prevValue !== expectedPrevValue) {
    return reject(
      "BACKING_VALUE_MISMATCH",
      `input 0 value ${prevValue} != anchor + R(old) ${expectedPrevValue}`,
    );
  }

  const outputs = readPsbtOutputs(params.psbt);

  // ── successor backing vault (vout 1) ──
  if (analysis.recipientVout !== MINT_CARRIER_VOUT) {
    return reject("CARRIER_MISSING", "canonical MINT carrier must be at vout 2");
  }
  const successor = outputs[1];
  if (!successor || !successor.script.equals(nextVault.scriptPubKey)) {
    return reject("SUCCESSOR_SCRIPT_MISMATCH", "output 1 is not the canonical successor vault");
  }
  const expectedSuccessorValue = RESERVE_ANCHOR_SATS + analysis.nextState.backingSats;
  if (successor.value !== expectedSuccessorValue) {
    return reject(
      "SUCCESSOR_VALUE_MISMATCH",
      `output 1 value ${successor.value} != anchor + R(next) ${expectedSuccessorValue}`,
    );
  }

  // ── buyer token carrier (vout 2) ──
  const carrier = outputs[MINT_CARRIER_VOUT];
  if (!carrier) return reject("CARRIER_MISSING", "no carrier output at vout 2");
  if (carrier.value !== TOKEN_CARRIER_SATS) {
    return reject(
      "CARRIER_VALUE_MISMATCH",
      `carrier value ${carrier.value} != ${TOKEN_CARRIER_SATS}`,
    );
  }
  if (!isStandardCarrier(carrier.script)) {
    return reject("CARRIER_NOT_STANDARD", "carrier is not P2TR/P2WPKH");
  }

  // ── protocol fee (vout 3) ──
  const feeOut = outputs[MINT_FEE_VOUT];
  if (!feeOut) return reject("FEE_MISMATCH", "no fee output at vout 3");
  if (feeOut.value !== analysis.protocolFeeSats) {
    return reject("FEE_MISMATCH", `fee ${feeOut.value} != ${analysis.protocolFeeSats}`);
  }
  if (!feeOut.script.equals(params.feeScript)) {
    return reject(
      "FEE_DESTINATION_MISMATCH",
      "fee output script is not the configured fee destination",
    );
  }

  // ── explicit fee-dust settlement (never a nonstandard fee output) ──
  const settlement = checkFeeSettlement(
    analysis.protocolFeeSats,
    params.feeScript,
    params.buyFeeBps ?? COVE_FEE_CONFIG.buyFeeBps,
  );
  if (!settlement.isStandard) {
    return reject(
      "PROTOCOL_FEE_DUST",
      `fee ${analysis.protocolFeeSats} < dust ${settlement.dustThresholdSats}; ` +
        `minimum gross ${settlement.minimumGrossForStandardFeeOutput}`,
    );
  }

  // ── creator share (vout 4), to the address recorded at DEPLOY ──
  const creatorOut = outputs[MINT_CREATOR_VOUT];
  if (
    !creatorOut ||
    creatorOut.value !== analysis.creatorFeeSats ||
    !creatorOut.script.equals(analysis.creatorScript)
  ) {
    return reject(
      "CREATOR_FEE_MISMATCH",
      `vout 4 must pay the creator ${analysis.creatorFeeSats} sats`,
    );
  }

  // ── advisory crc-20 discovery envelope (§D1): never read into state, but a
  //    contradicting payload is refused a signature outright ──
  const discovery = checkDiscoveryOutput(
    outputs,
    decodeCoveOpReturn(params.psbt),
    params.discoveryTicker,
  );
  if (discovery.present && !discovery.agrees) {
    return reject("DISCOVERY_MISMATCH", discovery.reason ?? "discovery envelope mismatch");
  }

  // ── no unexpected outputs (0..5: OP_RETURN, vault, carrier, fee, creator, change) ──
  if (outputs.length > 6 + discovery.allowance) {
    return reject("UNEXPECTED_OUTPUT", `too many outputs (${outputs.length})`);
  }

  // ── miner fee bounded ──
  if (analysis.minerFeeSats < 0n) {
    return reject("NEGATIVE_MINER_FEE", `miner fee ${analysis.minerFeeSats} is negative`);
  }
  if (analysis.minerFeeSats > maxMinerFee) {
    return reject("MINER_FEE_EXCEEDED", `miner fee ${analysis.minerFeeSats} > ${maxMinerFee}`);
  }

  // ── funding inputs: confirmed, and holding no tokens of any kind ──
  const fundingRejection = await checkFundingInputs(params, analysis.buyerInputIndices);
  if (fundingRejection) return fundingRejection;

  // ── canonical Simplicity witness (recomputed; caller values cross-checked) ──
  const w = buildCanonicalMintWitness({
    prevState: analysis.currentState,
    nextState: analysis.nextState,
    amountAtoms: analysis.amountAtoms,
    canonicalGrossSats: analysis.grossSats,
  });
  if (!w.ok) return reject("WITNESS_CONSTRUCTION_FAILED", w.detail);

  // ── REAL Simplicity execution ──
  const sim = await executeMintV3(w.witness);
  if (sim.failure === "CMR_MISMATCH") {
    return reject("CMR_MISMATCH", `compiled CMR ${sim.actualCmr} != ${sim.expectedCmr}`);
  }
  if (sim.result !== "PASS") {
    return reject("SIMPLICITY_REJECTED", `Simplicity result: ${sim.result} (${sim.failure})`);
  }

  // Full reference policy already passed (applyMintV2 in analyze recomputed the
  // exact R-delta and this function verified all output/value semantics).
  return { ok: true, analysis, simplicity: sim };
}

export async function validateRedeemTransitionV3(
  params: ValidateParams,
): Promise<ValidationResult> {
  const maxMinerFee = params.maxMinerFeeSats ?? 20_000n;

  // Mainnet requires the MAINNET1 recovery profile (fail closed; §36).
  if (
    params.network === "mainnet" &&
    params.recoveryProfile?.profileVersion !== "COVE_V3_VAULT_PROFILE_MAINNET1"
  ) {
    return reject("MAINNET_PROFILE_REQUIRED", "mainnet requires the MAINNET1 recovery profile");
  }

  let analysis: RedeemAnalysis;
  try {
    analysis = analyzeRedeemTransitionV3(params);
  } catch (e) {
    if (e instanceof CoveAnalyzeError) return reject(e.code, e.message);
    return reject("REFERENCE_POLICY_REJECTED", (e as Error).message);
  }

  const btcNet = bitcoinNetwork(params.network);
  const prevVault = buildBackingVaultV3({
    state: analysis.currentState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: btcNet,
  });
  const nextVault = buildBackingVaultV3({
    state: analysis.nextState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: btcNet,
  });

  // ── backing input (index 0) must be the exact canonical REDEEM leaf ──
  const input0 = params.psbt.data.inputs[0]!;
  if (!input0.tapInternalKey || !input0.tapInternalKey.equals(prevVault.numsKey)) {
    return reject("BACKING_SCRIPT_MISMATCH", "input 0 tapInternalKey != canonical NUMS key");
  }
  if (!input0.tapMerkleRoot || !input0.tapMerkleRoot.equals(prevVault.merkleRoot)) {
    return reject("BACKING_SCRIPT_MISMATCH", "input 0 tapMerkleRoot != canonical MAST root");
  }
  const redeemLeaf = input0.tapLeafScript?.[0];
  if (!redeemLeaf) return reject("WRONG_LEAF", "no tap leaf script on input 0");
  if (!redeemLeaf.script.equals(prevVault.redeemLeaf.script)) {
    return reject("WRONG_LEAF", "input 0 leaf is not the canonical REDEEM execution leaf");
  }
  if (!redeemLeaf.controlBlock.equals(prevVault.redeemControlBlock)) {
    return reject("BAD_CONTROL_BLOCK", "input 0 control block is wrong");
  }
  const expectedPrevValue = RESERVE_ANCHOR_SATS + analysis.currentState.backingSats;
  const prevValue = BigInt(input0.witnessUtxo!.value);
  if (prevValue !== expectedPrevValue) {
    return reject(
      "BACKING_VALUE_MISMATCH",
      `input 0 value ${prevValue} != anchor + R(old) ${expectedPrevValue}`,
    );
  }

  // ── token ownership + change exactness ──
  if (analysis.redeemAmountAtoms > analysis.tokenInputTotalAtoms) {
    return reject(
      "TOKEN_OWNERSHIP_INSUFFICIENT",
      `redeem ${analysis.redeemAmountAtoms} > token inputs ${analysis.tokenInputTotalAtoms}`,
    );
  }
  const changeAtoms = analysis.tokenInputTotalAtoms - analysis.redeemAmountAtoms;
  const wireChangeSum = analysis.changeAllocations.reduce((s, a) => s + a.amount, 0n);
  if (wireChangeSum !== changeAtoms) {
    return reject(
      "TOKEN_CHANGE_MISMATCH",
      `wire change sum ${wireChangeSum} != token change ${changeAtoms}`,
    );
  }

  const outputs = readPsbtOutputs(params.psbt);

  // ── successor vault (vout 1) ──
  const successor = outputs[REDEEM_SUCCESSOR_VOUT];
  if (!successor || !successor.script.equals(nextVault.scriptPubKey)) {
    return reject("SUCCESSOR_SCRIPT_MISMATCH", "output 1 is not the canonical successor vault");
  }
  const expectedSuccessorValue = RESERVE_ANCHOR_SATS + analysis.nextState.backingSats;
  if (successor.value !== expectedSuccessorValue) {
    return reject(
      "SUCCESSOR_VALUE_MISMATCH",
      `output 1 value ${successor.value} != anchor + R(next) ${expectedSuccessorValue}`,
    );
  }

  // ── seller payout (vout 2) ──
  const payout = outputs[REDEEM_PAYOUT_VOUT];
  if (!payout) return reject("PAYOUT_MISMATCH", "no payout output at vout 2");
  if (!isValidRedeemPayout(analysis.grossSats, analysis.protocolFeeSats, payout.value, payout.script)) {
    return reject("PAYOUT_MISMATCH", `payout ${payout.value} is neither the legacy net nor a standard wallet-funded payout`);
  }

  // ── protocol fee (vout 3) ──
  const feeOut = outputs[REDEEM_FEE_VOUT];
  if (!feeOut) return reject("FEE_MISMATCH", "no fee output at vout 3");
  if (feeOut.value !== analysis.protocolFeeSats) {
    return reject("FEE_MISMATCH", `fee ${feeOut.value} != ${analysis.protocolFeeSats}`);
  }
  if (!feeOut.script.equals(params.feeScript)) {
    return reject(
      "FEE_DESTINATION_MISMATCH",
      "fee output script is not the configured fee destination",
    );
  }

  // ── explicit fee-dust settlement ──
  const settlement = checkFeeSettlement(
    analysis.protocolFeeSats,
    params.feeScript,
    params.redeemFeeBps ?? COVE_FEE_CONFIG.redeemFeeBps,
  );
  if (!settlement.isStandard) {
    return reject(
      "PROTOCOL_FEE_DUST",
      `fee ${analysis.protocolFeeSats} < dust ${settlement.dustThresholdSats}; ` +
        `minimum gross ${settlement.minimumGrossForStandardFeeOutput}`,
    );
  }

  // ── change carrier (vout 4, only on partial redeem) ──
  if (changeAtoms > 0n) {
    const changeOut = outputs[REDEEM_CHANGE_CARRIER_VOUT];
    if (!changeOut) return reject("TOKEN_CHANGE_MISMATCH", "missing change carrier at vout 4");
    if (changeOut.value !== TOKEN_CARRIER_SATS) {
      return reject("CARRIER_VALUE_MISMATCH", `change carrier value ${changeOut.value}`);
    }
    if (!isStandardCarrier(changeOut.script)) {
      return reject("CARRIER_NOT_STANDARD", "change carrier is not P2TR/P2WPKH");
    }
    // wire change allocation must reference vout 4 with the exact amount
    if (
      analysis.changeAllocations.length !== 1 ||
      analysis.changeAllocations[0]!.vout !== REDEEM_CHANGE_CARRIER_VOUT ||
      analysis.changeAllocations[0]!.amount !== changeAtoms
    ) {
      return reject("TOKEN_CHANGE_MISMATCH", "wire change allocation does not match vout 4");
    }
  } else {
    if (analysis.changeAllocations.length !== 0) {
      return reject("TOKEN_INFLATION", "change allocations present on a full redeem");
    }
  }

  // ── no unexpected outputs ──
  //   partial redeem: 0..4 required (change carrier at 4), optional BTC change at 5 → max 6
  //   full redeem:    0..3 required, optional BTC change at 4 → max 5
  const discovery = checkDiscoveryOutput(
    outputs,
    decodeCoveOpReturn(params.psbt),
    params.discoveryTicker,
  );
  if (discovery.present && !discovery.agrees) {
    return reject("DISCOVERY_MISMATCH", discovery.reason ?? "discovery envelope mismatch");
  }
  const maxOutputs = (changeAtoms > 0n ? 6 : 5) + discovery.allowance;
  if (outputs.length > maxOutputs) {
    return reject("UNEXPECTED_OUTPUT", `too many outputs (${outputs.length})`);
  }

  // ── backing decreases exactly by gross; backing never pays miner fee ──
  const backingIn = prevValue;
  const backingOut =
    RESERVE_ANCHOR_SATS +
    analysis.nextState.backingSats +
    analysis.grossSats;
  if (backingIn !== backingOut) {
    return reject(
      "BACKING_DECREASE_MISMATCH",
      `backing input ${backingIn} != successor+gross ${backingOut}`,
    );
  }

  // ── miner fee bounded ──
  if (analysis.minerFeeSats < 0n) {
    return reject("NEGATIVE_MINER_FEE", `miner fee ${analysis.minerFeeSats} is negative`);
  }
  if (analysis.minerFeeSats > maxMinerFee) {
    return reject("MINER_FEE_EXCEEDED", `miner fee ${analysis.minerFeeSats} > ${maxMinerFee}`);
  }

  // ── funding inputs: everything except the vault and the token carriers ──
  const tokenInputs = new Set(analysis.tokenInputIndices);
  const fundingIndices = params.psbt.txInputs
    .map((_, i) => i)
    .filter((i) => i !== 0 && !tokenInputs.has(i));
  const fundingRejection = await checkFundingInputs(params, fundingIndices);
  if (fundingRejection) return fundingRejection;

  // ── canonical Simplicity witness ──
  const w = buildCanonicalRedeemWitness({
    prevState: analysis.currentState,
    nextState: analysis.nextState,
    amountAtoms: analysis.redeemAmountAtoms,
    canonicalGrossSats: analysis.grossSats,
  });
  if (!w.ok) return reject("WITNESS_CONSTRUCTION_FAILED", w.detail);

  // ── REAL Simplicity execution ──
  const sim = await executeRedeemV3(w.witness);
  if (sim.failure === "CMR_MISMATCH") {
    return reject("CMR_MISMATCH", `compiled CMR ${sim.actualCmr} != ${sim.expectedCmr}`);
  }
  if (sim.result !== "PASS") {
    return reject("SIMPLICITY_REJECTED", `Simplicity result: ${sim.result} (${sim.failure})`);
  }

  return { ok: true, analysis, simplicity: sim };
}
