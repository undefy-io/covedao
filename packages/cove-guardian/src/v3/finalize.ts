import * as bitcoin from "bitcoinjs-lib";
import { createHash } from "node:crypto";
import {
  TOKEN_CARRIER_SATS,
  applyMintV2,
  applyRedeemV2,
  type CoveStateV2,
} from "@crclaunch/cove-covenant";
import { buildBackingVaultV3, type VaultRecoveryProfile } from "@crclaunch/cove-vault";
import { executeMintV3, executeRedeemV3 } from "@crclaunch/cove-simplicity";
import { OP_DEPLOY, OP_MINT, OP_REDEEM, OP_TRANSFER, computeTokenId } from "@crclaunch/cove-wire";
import { isValidRedeemPayout, COVE_FEE_CONFIG, CREATOR_RECORD_SATS, LAUNCH_FEE_SATS, checkFeeSettlement, creatorFeeSats, isCreatorScript, mintFeeSats, redeemFeeSats, isP2TR, isP2WPKH } from "@crclaunch/cove-economics";
import { s0StateV2 } from "@crclaunch/cove-covenant";
import { RESERVE_ANCHOR_SATS } from "./builder.js";
import { decodeCoveOpReturnTx } from "./resolve.js";
import { checkDiscoveryOutput } from "./discoveryOutput.js";
import { buildCanonicalMintWitness, buildCanonicalRedeemWitness } from "./witness.js";
import type { CoveCanonicalView, GuardianV3Network } from "./types.js";

/**
 * Finalized-transaction revalidation (Phase 4.4 §14, hardened Phase 5 §2).
 * Consume FINAL RAW TX BYTES, parse from scratch, resolve canonical prevouts,
 * and re-run every reconstructable invariant. On success they return an opaque
 * branded `ValidatedCoveTransaction` that ONLY these functions can construct —
 * the production broadcast boundary (broadcast.ts) accepts nothing else.
 */

const ValidatedCoveTransactionBrand: unique symbol = Symbol("ValidatedCoveTransaction");

export interface ValidatedCoveTransaction {
  readonly [ValidatedCoveTransactionBrand]: true;
  readonly rawTxHex: string;
  readonly txid: string;
  readonly operation: "DEPLOY" | "MINT" | "REDEEM" | "TRANSFER";
  readonly tokenId: string;
  readonly validationDigest: string;
}

export interface FinalValidationRejection {
  ok: false;
  reason: string;
}

export type FinalValidationResult = ValidatedCoveTransaction | FinalValidationRejection;

/** Resolved prevout script + value, keyed by "txid:vout" (canonical, big-endian). */
export interface ResolvedPrevout {
  script: Buffer;
  valueSats: bigint;
}

export interface FinalizeParams {
  rawTxHex: string;
  view: CoveCanonicalView;
  network: GuardianV3Network;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  feeScript: Buffer;
  maxMinerFeeSats?: bigint;
  /** Resolved prevouts for EVERY input, captured independently before signing. */
  prevouts?: Map<string, ResolvedPrevout>;
  /** Protocol fee schedule (bps). Defaults to the development COVE_FEE_CONFIG. */
  buyFeeBps?: bigint;
  /** Flat sats added on top of the percentage. */
  buyFeeFlatSats?: bigint;
  /** Creator share of a mint, bps of the curve price. */
  creatorFeeBps?: bigint;
  redeemFeeBps?: bigint;
  /** Flat sats deducted on top of the percentage. */
  redeemFeeFlatSats?: bigint;
  discoveryTicker?: string;
}

const MAX_MINER_FEE = 20_000n;

function reject(reason: string): FinalValidationRejection {
  return { ok: false, reason };
}

function btcNetwork(network: GuardianV3Network): bitcoin.networks.Network {
  switch (network) {
    case "regtest":
      return bitcoin.networks.regtest;
    case "mainnet":
      return bitcoin.networks.bitcoin;
    case "testnet":
    case "signet":
      return bitcoin.networks.testnet;
    default:
      throw new Error(`bad network ${String(network)}`);
  }
}

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

function validated(
  rawTxHex: string,
  txid: string,
  operation: ValidatedCoveTransaction["operation"],
  tokenId: string,
): ValidatedCoveTransaction {
  const digest = createHash("sha256").update(rawTxHex, "hex").digest("hex");
  return {
    [ValidatedCoveTransactionBrand]: true,
    rawTxHex,
    txid,
    operation,
    tokenId,
    validationDigest: digest,
  };
}

function isStandardCarrier(script: Buffer): boolean {
  return isP2TR(script) || isP2WPKH(script);
}

function parseTx(rawTxHex: string): bitcoin.Transaction | FinalValidationRejection {
  try {
    return bitcoin.Transaction.fromHex(rawTxHex);
  } catch (e) {
    return reject(`BAD_TX: ${(e as Error).message}`);
  }
}

function decodeWire(tx: bitcoin.Transaction) {
  try {
    return decodeCoveOpReturnTx(tx);
  } catch (e) {
    return reject((e as Error).message);
  }
}

function inputTxid(ins: bitcoin.TxInput): string {
  return Buffer.from(ins.hash).reverse().toString("hex");
}

function checkMinerFee(
  tx: bitcoin.Transaction,
  prevouts: Map<string, ResolvedPrevout> | undefined,
  maxMinerFee: bigint,
): FinalValidationRejection | null {
  if (!prevouts) return null; // caller opted out (backwards-compat test path)
  let totalIn = 0n;
  for (const ins of tx.ins) {
    const key = outpointKey(inputTxid(ins), ins.index);
    const p = prevouts.get(key);
    if (!p) return reject(`UNRESOLVED_PREVOUT: ${key}`);
    totalIn += p.valueSats;
  }
  const totalOut = tx.outs.reduce((s, o) => s + BigInt(o.value), 0n);
  const minerFee = totalIn - totalOut;
  if (minerFee < 0n) return reject(`NEGATIVE_MINER_FEE: ${minerFee}`);
  if (minerFee > maxMinerFee) return reject(`MINER_FEE_EXCEEDED: ${minerFee} > ${maxMinerFee}`);
  return null;
}

export function validateFinalizedDeployTransaction(params: {
  rawTxHex: string;
  network: GuardianV3Network;
  chainIdentity: string;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  /** The protocol fee address: DEPLOY output 3 pays it exactly LAUNCH_FEE_SATS. */
  feeScript: Buffer;
}): FinalValidationResult {
  const parsed = parseTx(params.rawTxHex);
  if (!(parsed instanceof bitcoin.Transaction)) return parsed;
  const tx = parsed;
  const wire = decodeWire(tx);
  if ("ok" in wire) return wire;
  if (wire.op !== OP_DEPLOY) return reject("WRONG_OPCODE");

  // The tokenId commits to the creator, so the creator output is read first.
  const creatorOut = tx.outs[2];
  if (!creatorOut || BigInt(creatorOut.value) !== CREATOR_RECORD_SATS || !isCreatorScript(creatorOut.script)) {
    return reject("CREATOR_OUTPUT_MISSING");
  }
  const launchFeeOut = tx.outs[3];
  if (!launchFeeOut || BigInt(launchFeeOut.value) !== LAUNCH_FEE_SATS || !launchFeeOut.script.equals(params.feeScript)) {
    return reject("LAUNCH_FEE_MISSING");
  }
  const tokenId = computeTokenId({
    chainIdentity: params.chainIdentity,
    policyVersion: wire.policyVersion,
    ticker: wire.ticker,
    tokenNonce: wire.tokenNonce,
    creatorScript: creatorOut.script,
  });
  const s0 = s0StateV2({ tokenId: tokenId.toString("hex") });
  const vault = buildBackingVaultV3({
    state: s0,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
      recoveryProfile: params.recoveryProfile,
    network: btcNetwork(params.network),
  });
  const s0Out = tx.outs[1];
  if (!s0Out || !s0Out.script.equals(vault.scriptPubKey)) {
    return reject("S0_VAULT_MISMATCH");
  }
  if (BigInt(s0Out.value) !== RESERVE_ANCHOR_SATS) {
    return reject("S0_ANCHOR_MISMATCH");
  }
  const discovery = checkDiscoveryOutput(
    tx.outs.map((o, vout) => ({ vout, script: o.script, value: BigInt(o.value) })),
    wire,
    wire.ticker,
  );
  if (discovery.present && !discovery.agrees) return reject("DISCOVERY_MISMATCH");
  if (tx.outs.length > 5 + discovery.allowance) return reject("UNEXPECTED_OUTPUT");
  return validated(params.rawTxHex, tx.getId(), "DEPLOY", tokenId.toString("hex"));
}

export async function validateFinalizedMintTransaction(params: FinalizeParams): Promise<FinalValidationResult> {
  const maxMinerFee = params.maxMinerFeeSats ?? MAX_MINER_FEE;
  const parsed = parseTx(params.rawTxHex);
  if (!(parsed instanceof bitcoin.Transaction)) return parsed;
  const tx = parsed;
  const wire = decodeWire(tx);
  if ("ok" in wire) return wire;
  if (wire.op !== OP_MINT) return reject("WRONG_OPCODE");
  const tokenId = wire.tokenId;

  const currentState = params.view.getCurrentBackingState(tokenId);
  if (!currentState) return reject("UNKNOWN_TOKEN");
  const backingOutpoint = params.view.getBackingOutpoint(tokenId);
  if (!backingOutpoint) return reject("UNKNOWN_TOKEN");

  const ins0 = tx.ins[0];
  if (!ins0) return reject("BAD_TX");
  if (inputTxid(ins0) !== backingOutpoint.txid || ins0.index !== backingOutpoint.vout) {
    return reject("BACKING_VOUT_MISMATCH");
  }

  // actual previous backing script/value (from resolved prevouts if provided)
  const prevVault = buildBackingVaultV3({
    state: currentState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
      recoveryProfile: params.recoveryProfile,
    network: btcNetwork(params.network),
  });
  const expectedPrevValue = RESERVE_ANCHOR_SATS + currentState.backingSats;
  const prevKey = outpointKey(inputTxid(ins0), ins0.index);
  const prev0 = params.prevouts?.get(prevKey);
  if (prev0) {
    if (!prev0.script.equals(prevVault.scriptPubKey)) return reject("BACKING_SCRIPT_MISMATCH");
    if (prev0.valueSats !== expectedPrevValue) return reject("BACKING_VALUE_MISMATCH");
  }

  let nextState: CoveStateV2;
  let grossSats: bigint;
  try {
    const canonical = applyMintV2(currentState, wire.amount);
    nextState = canonical.nextState;
    grossSats = canonical.grossSats;
  } catch (e) {
    return reject(`REFERENCE_POLICY_REJECTED: ${(e as Error).message}`);
  }
  const protocolFeeSats = mintFeeSats(grossSats, wire.amount, params.buyFeeBps ?? COVE_FEE_CONFIG.buyFeeBps, params.buyFeeFlatSats ?? COVE_FEE_CONFIG.buyFeeFlatSats);

  const nextVault = buildBackingVaultV3({
    state: nextState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
      recoveryProfile: params.recoveryProfile,
    network: btcNetwork(params.network),
  });
  const successor = tx.outs[1];
  if (!successor || !successor.script.equals(nextVault.scriptPubKey)) {
    return reject("SUCCESSOR_SCRIPT_MISMATCH");
  }
  if (BigInt(successor.value) !== RESERVE_ANCHOR_SATS + nextState.backingSats) {
    return reject("SUCCESSOR_VALUE_MISMATCH");
  }
  if (wire.recipientVout !== 2) return reject("CARRIER_MISSING");
  const carrier = tx.outs[2];
  if (!carrier) return reject("CARRIER_MISSING");
  if (BigInt(carrier.value) !== TOKEN_CARRIER_SATS) return reject("CARRIER_VALUE_MISMATCH");
  if (!isStandardCarrier(carrier.script)) return reject("CARRIER_NOT_STANDARD");
  const feeOut = tx.outs[3];
  if (!feeOut || BigInt(feeOut.value) !== protocolFeeSats || !feeOut.script.equals(params.feeScript)) {
    return reject("FEE_MISMATCH");
  }
  const settlement = checkFeeSettlement(protocolFeeSats, params.feeScript, params.buyFeeBps ?? COVE_FEE_CONFIG.buyFeeBps);
  if (!settlement.isStandard) return reject("PROTOCOL_FEE_DUST");
  const creatorScript = params.view.getTokenCreatorScript?.(tokenId) ?? null;
  if (!creatorScript) return reject("CREATOR_UNKNOWN");
  const creatorOut = tx.outs[4];
  if (
    !creatorOut ||
    BigInt(creatorOut.value) !== creatorFeeSats(grossSats, params.creatorFeeBps ?? COVE_FEE_CONFIG.creatorFeeBps) ||
    !creatorOut.script.equals(creatorScript)
  ) {
    return reject("CREATOR_FEE_MISMATCH");
  }
  // OP_RETURN, vault, carrier, fee, creator, change — plus a matching
  // discovery OP_RETURN when it is the last output.
  const discovery = checkDiscoveryOutput(
    tx.outs.map((o, vout) => ({ vout, script: o.script, value: BigInt(o.value) })),
    wire,
    params.discoveryTicker,
  );
  if (discovery.present && !discovery.agrees) return reject("DISCOVERY_MISMATCH");
  if (tx.outs.length > 6 + discovery.allowance) return reject("UNEXPECTED_OUTPUT");

  const minerFeeErr = checkMinerFee(tx, params.prevouts, maxMinerFee);
  if (minerFeeErr) return minerFeeErr;

  const w = buildCanonicalMintWitness({
    prevState: currentState,
    nextState,
    amountAtoms: wire.amount,
    canonicalGrossSats: grossSats,
  });
  if (!w.ok) return reject("WITNESS_CONSTRUCTION_FAILED");
  const sim = await executeMintV3(w.witness);
  if (sim.result !== "PASS") return reject(sim.failure ?? "SIMPLICITY_REJECTED");

  return validated(params.rawTxHex, tx.getId(), "MINT", tokenId.toString("hex"));
}

export async function validateFinalizedRedeemTransaction(params: FinalizeParams): Promise<FinalValidationResult> {
  const maxMinerFee = params.maxMinerFeeSats ?? MAX_MINER_FEE;
  const parsed = parseTx(params.rawTxHex);
  if (!(parsed instanceof bitcoin.Transaction)) return parsed;
  const tx = parsed;
  const wire = decodeWire(tx);
  if ("ok" in wire) return wire;
  if (wire.op !== OP_REDEEM) return reject("WRONG_OPCODE");
  const tokenId = wire.tokenId;

  const currentState = params.view.getCurrentBackingState(tokenId);
  if (!currentState) return reject("UNKNOWN_TOKEN");
  const backingOutpoint = params.view.getBackingOutpoint(tokenId);
  if (!backingOutpoint) return reject("UNKNOWN_TOKEN");

  const ins0 = tx.ins[0];
  if (!ins0) return reject("BAD_TX");
  if (inputTxid(ins0) !== backingOutpoint.txid || ins0.index !== backingOutpoint.vout) {
    return reject("BACKING_VOUT_MISMATCH");
  }

  const prevVault = buildBackingVaultV3({
    state: currentState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
      recoveryProfile: params.recoveryProfile,
    network: btcNetwork(params.network),
  });
  const expectedPrevValue = RESERVE_ANCHOR_SATS + currentState.backingSats;
  const prev0 = params.prevouts?.get(outpointKey(inputTxid(ins0), ins0.index));
  if (prev0) {
    if (!prev0.script.equals(prevVault.scriptPubKey)) return reject("BACKING_SCRIPT_MISMATCH");
    if (prev0.valueSats !== expectedPrevValue) return reject("BACKING_VALUE_MISMATCH");
  }

  // resolve seller token inputs from actual outpoints
  let tokenInputTotalAtoms = 0n;
  for (let i = 1; i < tx.ins.length; i++) {
    const ins = tx.ins[i]!;
    const tok = params.view.getTokenUtxo({ txid: inputTxid(ins), vout: ins.index });
    if (tok) {
      if (!tok.tokenId.equals(tokenId)) return reject("MIXED_TOKEN_INPUT");
      tokenInputTotalAtoms += tok.amountAtoms;
    }
  }
  if (tokenInputTotalAtoms === 0n) return reject("FORGED_TOKEN_INPUT");

  const changeAtoms = tokenInputTotalAtoms - wire.redeemAmount;
  if (changeAtoms < 0n) return reject("TOKEN_OWNERSHIP_INSUFFICIENT");
  const wireChangeSum = wire.changeAllocations.reduce((s, a) => s + a.amount, 0n);
  if (wireChangeSum !== changeAtoms) return reject("TOKEN_CHANGE_MISMATCH");

  let nextState: CoveStateV2;
  let grossSats: bigint;
  try {
    const canonical = applyRedeemV2(currentState, wire.redeemAmount);
    nextState = canonical.nextState;
    grossSats = canonical.grossSats;
  } catch (e) {
    return reject(`REFERENCE_POLICY_REJECTED: ${(e as Error).message}`);
  }
  const protocolFeeSats = redeemFeeSats(grossSats, params.redeemFeeBps ?? COVE_FEE_CONFIG.redeemFeeBps, params.redeemFeeFlatSats ?? COVE_FEE_CONFIG.redeemFeeFlatSats);

  const nextVault = buildBackingVaultV3({
    state: nextState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
      recoveryProfile: params.recoveryProfile,
    network: btcNetwork(params.network),
  });
  const successor = tx.outs[1];
  if (!successor || !successor.script.equals(nextVault.scriptPubKey)) {
    return reject("SUCCESSOR_SCRIPT_MISMATCH");
  }
  if (BigInt(successor.value) !== RESERVE_ANCHOR_SATS + nextState.backingSats) {
    return reject("SUCCESSOR_VALUE_MISMATCH");
  }
  const payout = tx.outs[2];
  if (!payout || !isValidRedeemPayout(grossSats, protocolFeeSats, BigInt(payout.value), payout.script)) return reject("PAYOUT_MISMATCH");
  const feeOut = tx.outs[3];
  if (!feeOut || BigInt(feeOut.value) !== protocolFeeSats || !feeOut.script.equals(params.feeScript)) {
    return reject("FEE_MISMATCH");
  }
  const settlement = checkFeeSettlement(protocolFeeSats, params.feeScript, params.redeemFeeBps ?? COVE_FEE_CONFIG.redeemFeeBps);
  if (!settlement.isStandard) return reject("PROTOCOL_FEE_DUST");

  // Freeze the canonical layout (§3):
  //   FULL redeem:    0 OP_RETURN,1 vault,2 payout,3 fee,4 optional BTC change (max 5)
  //   PARTIAL redeem: 0 OP_RETURN,1 vault,2 payout,3 fee,4 token change carrier,5 optional BTC change (max 6)
  const discovery = checkDiscoveryOutput(
    tx.outs.map((o, vout) => ({ vout, script: o.script, value: BigInt(o.value) })),
    wire,
    params.discoveryTicker,
  );
  if (discovery.present && !discovery.agrees) return reject("DISCOVERY_MISMATCH");
  if (changeAtoms > 0n) {
    const changeOut = tx.outs[4];
    if (!changeOut) return reject("TOKEN_CHANGE_MISMATCH");
    if (BigInt(changeOut.value) !== TOKEN_CARRIER_SATS) return reject("CARRIER_VALUE_MISMATCH");
    if (!isStandardCarrier(changeOut.script)) return reject("CARRIER_NOT_STANDARD");
    if (
      wire.changeAllocations.length !== 1 ||
      wire.changeAllocations[0]!.vout !== 4 ||
      wire.changeAllocations[0]!.amount !== changeAtoms
    ) {
      return reject("TOKEN_CHANGE_MISMATCH");
    }
    if (tx.outs.length > 6 + discovery.allowance) return reject("UNEXPECTED_OUTPUT");
  } else {
    if (wire.changeAllocations.length !== 0) return reject("TOKEN_INFLATION");
    // output 4 (if present) is ordinary seller BTC change, NOT a token carrier.
    if (tx.outs.length > 5 + discovery.allowance) return reject("UNEXPECTED_OUTPUT");
  }

  const minerFeeErr = checkMinerFee(tx, params.prevouts, maxMinerFee);
  if (minerFeeErr) return minerFeeErr;

  const w = buildCanonicalRedeemWitness({
    prevState: currentState,
    nextState,
    amountAtoms: wire.redeemAmount,
    canonicalGrossSats: grossSats,
  });
  if (!w.ok) return reject("WITNESS_CONSTRUCTION_FAILED");
  const sim = await executeRedeemV3(w.witness);
  if (sim.result !== "PASS") return reject(sim.failure ?? "SIMPLICITY_REJECTED");

  return validated(params.rawTxHex, tx.getId(), "REDEEM", tokenId.toString("hex"));
}

export function validateFinalizedTransferTransaction(params: {
  rawTxHex: string;
  view: CoveCanonicalView;
  prevouts?: Map<string, ResolvedPrevout>;
  maxMinerFeeSats?: bigint;
  discoveryTicker?: string;
}): FinalValidationResult {
  const parsed = parseTx(params.rawTxHex);
  if (!(parsed instanceof bitcoin.Transaction)) return parsed;
  const tx = parsed;
  const wire = decodeWire(tx);
  if ("ok" in wire) return wire;
  if (wire.op !== OP_TRANSFER) return reject("WRONG_OPCODE");
  const tokenId = wire.tokenId;

  let tokenIn = 0n;
  for (const ins of tx.ins) {
    const tok = params.view.getTokenUtxo({ txid: inputTxid(ins), vout: ins.index });
    if (tok) {
      if (!tok.tokenId.equals(tokenId)) return reject("MIXED_TOKEN_INPUT");
      tokenIn += tok.amountAtoms;
    }
  }
  if (tokenIn === 0n) return reject("FORGED_TOKEN_INPUT");
  const allocSum = wire.allocations.reduce((s, a) => s + a.amount, 0n);
  if (allocSum !== tokenIn) return reject(`TOKEN_CONSERVATION: in=${tokenIn} out=${allocSum}`);
  // allocation carrier outputs must be standard + exact carrier sats
  for (const a of wire.allocations) {
    const out = tx.outs[a.vout];
    if (!out) return reject("ALLOCATION_VOUT_MISSING");
    if (BigInt(out.value) !== TOKEN_CARRIER_SATS) return reject("CARRIER_VALUE_MISMATCH");
    if (!isStandardCarrier(out.script)) return reject("CARRIER_NOT_STANDARD");
  }

  const discovery = checkDiscoveryOutput(
    tx.outs.map((o, vout) => ({ vout, script: o.script, value: BigInt(o.value) })),
    wire,
    params.discoveryTicker,
  );
  if (discovery.present && !discovery.agrees) return reject("DISCOVERY_MISMATCH");

  const maxMinerFee = params.maxMinerFeeSats ?? MAX_MINER_FEE;
  const minerFeeErr = checkMinerFee(tx, params.prevouts, maxMinerFee);
  if (minerFeeErr) return minerFeeErr;

  return validated(params.rawTxHex, tx.getId(), "TRANSFER", tokenId.toString("hex"));
}

export { outpointKey };
