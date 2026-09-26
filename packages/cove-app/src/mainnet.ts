import { AppError } from "./errors.js";
import { validateMainnetProfile, type MainnetProfile } from "@crclaunch/cove-mainnet";

/**
 * Phase 8.1 mainnet activation machinery (§27-§34, §42-§44). Mainnet is a
 * deterministic function of the ONE canonical committed profile (cove-mainnet)
 * + operational health — never a single boolean. Consensus/economic values are
 * committed profile constants; runtime env must NOT redefine them.
 */

export type { MainnetProfile } from "@crclaunch/cove-mainnet";

export type MainnetStage =
  | "DISABLED"
  | "READ_ONLY"
  | "SHADOW"
  | "CANARY_READY"
  | "CANARY_ACTIVE"
  | "CANARY_COMPLETE"
  | "PUBLIC_READY"
  | "PUBLIC_ACTIVE";

/** Operator decisions that are required before canary and are NEVER inferred. */
export const OWNER_DECISION_KEYS = [
  "activationHeight",
  "guardianXOnly",
  "recovery.pubkeys",
  "recovery.csvBlocks",
  "feeScript",
  "buyFeeBps",
  "redeemFeeBps",
  "p2pFeeBps",
  "canary.allowedWalletScripts",
  "canary.allowedTokenIds",
  "canary.maxBackingSats",
  "canary.maxSingleBuySats",
  "canary.maxSingleRedeemPayoutSats",
  "canary.maxP2pSettlementSats",
] as const;

/** The profile is statically complete iff the canonical validator passes. */
export function mainnetProfileComplete(p: MainnetProfile, opts: { allowTestKeys?: boolean } = {}): boolean {
  return validateMainnetProfile(p, opts).ok;
}

/** List the OWNER_DECISION_REQUIRED decisions still missing from a profile. */
export function missingOwnerDecisions(p: MainnetProfile): string[] {
  return validateMainnetProfile(p).errors.filter((e) => e.startsWith("OWNER_DECISION_REQUIRED"));
}

export interface MainnetHealth {
  primaryCoreHealthy: boolean;
  secondaryCoreHealthy: boolean;
  coreAgreement: boolean;
  indexerHealthy: boolean;
  stateRootVerified: boolean;
  workerHealthy: boolean;
  guardianHealthy: boolean;
  guardianProfileHashMatches: boolean;
  guardianKeyMatches: boolean;
  auditHealthy: boolean;
  signingJournalHealthy: boolean;
  profileHashMatches: boolean;
}

/**
 * Deterministic mainnet activation stage (§27/§28). Default DISABLED. A canary
 * can only be ACTIVE when the profile is complete, the profile hash matches,
 * and EVERY required health signal is green — including the SECONDARY Core and
 * Core agreement (§28).
 */
export function deriveMainnetStage(
  p: MainnetProfile,
  canaryActive: boolean,
  health: MainnetHealth,
  /** TESTS/CI ONLY: the profile is a test-only one (repo test keys allowed). */
  opts: { allowTestKeys?: boolean } = {},
): MainnetStage {
  if (!mainnetProfileComplete(p, opts)) return "DISABLED";
  if (!health.profileHashMatches) return "DISABLED";
  if (!health.primaryCoreHealthy || !health.secondaryCoreHealthy || !health.coreAgreement || !health.indexerHealthy) return "READ_ONLY";
  if (!health.stateRootVerified || !health.workerHealthy) return "READ_ONLY";
  if (!health.guardianHealthy || !health.guardianProfileHashMatches || !health.guardianKeyMatches || !health.auditHealthy || !health.signingJournalHealthy) return "READ_ONLY";
  if (!canaryActive) return "CANARY_READY";
  return "CANARY_ACTIVE";
}

/** Mainnet web/worker MUST NOT load a local Guardian key (§11/§43). */
export function assertNoLocalGuardianKeyOnMainnet(network: string, guardianPrivateKey: Buffer | null): void {
  if (network === "mainnet" && guardianPrivateKey !== null) {
    throw new AppError("MAINNET_DISABLED", "mainnet must use the remote Guardian service; local Guardian key is forbidden");
  }
}

/** Mainnet MUST NOT load a recovery private key (§44). Recovery is offline. */
export function assertNoRecoveryPrivateKeyOnMainnet(network: string, recoveryPrivateKey: Buffer | null): void {
  if (network === "mainnet" && recoveryPrivateKey !== null) {
    throw new AppError("MAINNET_DISABLED", "mainnet recovery private keys are offline-only and forbidden in the app");
  }
}
