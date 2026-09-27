import type { CoveStateV2, OutPoint } from "@crclaunch/cove-covenant";
import type { SimplicityExecutionResult } from "@crclaunch/cove-simplicity";

/**
 * Production Guardian V3 shared types (§6/§7).
 */

/**
 * Networks the Guardian signs for. Mainnet additionally requires the MAINNET1
 * recovery profile (validate.ts) and is signed only by the Guardian service.
 */
export type GuardianV3Network = "regtest" | "signet" | "testnet" | "mainnet";

/**
 * Minimal canonical view interface the Guardian resolves against. It lives in
 * cove-covenant (shared with the production indexer's snapshot loader); re-exported
 * here for the Guardian's own import surface.
 */
export type { CoveCanonicalView } from "@crclaunch/cove-covenant";

/** Typed reasons the Guardian refuses to sign (fail-closed). */
export type ValidationFailureCode =
  | "MAINNET_DISABLED"
  | "CREATOR_UNKNOWN"
  | "CREATOR_FEE_MISMATCH"
  | "CREATOR_OUTPUT_MISSING"
  | "MAINNET_PROFILE_REQUIRED"
  | "BAD_NETWORK"
  | "BAD_PSBT"
  | "NO_COVE_OP_RETURN"
  | "NONCANONICAL_WIRE"
  | "WRONG_OPCODE"
  | "UNKNOWN_TOKEN"
  | "STALE_BACKING"
  | "BACKING_SCRIPT_MISMATCH"
  | "BACKING_VALUE_MISMATCH"
  | "BACKING_VOUT_MISMATCH"
  | "SUCCESSOR_SCRIPT_MISMATCH"
  | "SUCCESSOR_VALUE_MISMATCH"
  | "CARRIER_MISSING"
  | "CARRIER_VALUE_MISMATCH"
  | "CARRIER_NOT_STANDARD"
  | "FEE_MISMATCH"
  | "FEE_DESTINATION_MISMATCH"
  | "INSUFFICIENT_FUNDING"
  | "MINER_FEE_EXCEEDED"
  | "NEGATIVE_MINER_FEE"
  | "UNEXPECTED_OUTPUT"
  | "DISCOVERY_MISMATCH"
  | "WRONG_LEAF"
  | "BAD_CONTROL_BLOCK"
  | "POLICY_IDENTITY_MISMATCH"
  | "WITNESS_CONSTRUCTION_FAILED"
  | "SIMPLICITY_REJECTED"
  | "REFERENCE_POLICY_REJECTED"
  | "CMR_MISMATCH"
  | "TOKEN_OWNERSHIP_INSUFFICIENT"
  | "REDEEM_EXCEEDS_SUPPLY"
  | "TOKEN_INFLATION"
  | "PAYOUT_MISMATCH"
  | "BACKING_DECREASE_MISMATCH"
  | "MIXED_TOKEN_INPUT"
  | "FORGED_TOKEN_INPUT"
  | "TOKEN_CHANGE_MISMATCH"
  | "PROTOCOL_FEE_DUST"
  | "FUNDING_UNCONFIRMED"
  | "FUNDING_PREVOUT_MISMATCH"
  | "FUNDING_HOLDS_TOKEN"
  | "FUNDING_CHECK_UNAVAILABLE";

export interface ValidationRejection {
  ok: false;
  reason: ValidationFailureCode;
  detail: string;
}

/** The canonical reconstructed MINT transition (produced by analyze, checked by validate). */
export interface MintAnalysis {
  op: "MINT";
  tokenId: Buffer;
  amountAtoms: bigint;
  recipientVout: number;
  currentState: CoveStateV2;
  backingOutpoint: OutPoint;
  nextState: CoveStateV2;
  grossSats: bigint;
  protocolFeeSats: bigint;
  /** The creator's share, paid at vout 4 to the script recorded at DEPLOY. */
  creatorFeeSats: bigint;
  creatorScript: Buffer;
  minerFeeSats: bigint;
  backingInputIndex: number;
  buyerInputIndices: number[];
}

/** The canonical reconstructed REDEEM transition. */
export interface RedeemAnalysis {
  op: "REDEEM";
  tokenId: Buffer;
  redeemAmountAtoms: bigint;
  changeAllocations: { vout: number; amount: bigint }[];
  currentState: CoveStateV2;
  backingOutpoint: OutPoint;
  tokenInputOutpoints: OutPoint[];
  tokenInputTotalAtoms: bigint;
  nextState: CoveStateV2;
  grossSats: bigint;
  protocolFeeSats: bigint;
  netPayoutSats: bigint;
  minerFeeSats: bigint;
  backingInputIndex: number;
  tokenInputIndices: number[];
}

export type CoveAnalysis = MintAnalysis | RedeemAnalysis;

export interface ValidationOk {
  ok: true;
  analysis: CoveAnalysis;
  /** The captured real Simplicity execution result (for the audit record). */
  simplicity: SimplicityExecutionResult;
}

export type ValidationResult = ValidationOk | ValidationRejection;

/** A successful, audit-backed Guardian signature on a backing-state spend. */
export interface SignedTransitionResult {
  ok: true;
  operation: "MINT" | "REDEEM";
  tokenId: string;
  prevStateHash: string;
  nextStateHash: string;
  expectedCmr: string;
  actualCmr: string;
  simplicityResult: "PASS" | "FAIL";
  referencePolicyResult: "PASS";
  backingOutpoint: OutPoint;
  signedInputIndex: number;
  audit: AuditRecord;
  /** Non-null when the post-sign audit finalization failed (SIGNED_BUT_AUDIT_FINALIZATION_FAILED). */
  auditFinalizationError: string | null;
}

export interface AuditRecord {
  requestId: string;
  operation: "MINT" | "REDEEM";
  tokenId: string;
  prevStateHash: string;
  nextStateHash: string;
  backingOutpoint: OutPoint;
  tokenInputOutpoints: OutPoint[];
  amountAtoms: bigint;
  grossSats: bigint;
  protocolFeeSats: bigint;
  minerFeeSats: bigint;
  policyVersion: number;
  expectedCmr: string;
  actualCmr: string;
  simplicityResult: "PASS" | "FAIL";
  referencePolicyResult: "PASS" | "FAIL";
  unsignedTxDigest: string;
  network: GuardianV3Network;
  decision: "VALID_TO_SIGN" | "REJECTED";
  rejectionReason: string | null;
  timestamp: string;
}

export interface ResolvedInput {
  txid: string;
  vout: number;
  script: Buffer;
  valueSats: bigint;
}
