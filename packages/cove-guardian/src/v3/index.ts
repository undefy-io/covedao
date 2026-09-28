/**
 * Production Cove Guardian V3 — the enforcement / Simplicity signing gate.
 *
 * The ONLY backing-state signing entry points are validateAndSignMintTransition
 * and validateAndSignRedeemTransition. Every path runs: independent parse →
 * canonical reconstruction → real Simplicity execution → independent TS/reference
 * validation → CMR verification → full transaction validation → script-path
 * signing → finalized-tx revalidation.
 */
export {
  GuardianV3Signer,
  type VaultLeafRef,
} from "./signer.js";
export {
  signVaultExecutionLeafWithCustody,
  localSigningBackend,
  custodySigningBackend,
  TestGuardianCustodyBackend,
  EnvGuardianCustodyBackend,
  UnconfiguredGuardianCustodyBackend,
  type GuardianCustodyBackend,
  type GuardianSigningBackend,
} from "./custody.js";
export {
  validateAndSignMintTransition,
  validateAndSignRedeemTransition,
  type SignTransitionParams,
  type SignTransitionOutcome,
} from "./guardian.js";
export {
  chainFundingChecker,
  ordAssetLookup,
  type FundingInputChecker,
  type FundingInputVerdict,
  type FundingInputCode,
  type AssetLookup,
  type TxOutReader,
} from "./funding.js";
export {
  validateMintTransitionV3,
  validateRedeemTransitionV3,
  type ValidateParams,
} from "./validate.js";
export {
  analyzeMintTransitionV3,
  analyzeRedeemTransitionV3,
  CoveAnalyzeError,
  type AnalyzeParams,
} from "./analyze.js";
export {
  validateFinalizedDeployTransaction,
  validateFinalizedMintTransaction,
  validateFinalizedRedeemTransaction,
  validateFinalizedTransferTransaction,
  type FinalizeParams,
  type FinalValidationResult,
  type FinalValidationRejection,
  type ValidatedCoveTransaction,
  type ResolvedPrevout,
} from "./finalize.js";
export {
  buildCanonicalMintWitness,
  buildCanonicalRedeemWitness,
  type WitnessResult,
} from "./witness.js";
export {
  consoleAuditSink,
  noopAuditSink,
  type AuditSink,
} from "./audit.js";
export {
  broadcastValidatedCoveTransaction,
  type BroadcastResult,
} from "./broadcast.js";
export type {
  CoveCanonicalView,
  GuardianV3Network,
  MintAnalysis,
  RedeemAnalysis,
  CoveAnalysis,
  ValidationResult,
  ValidationOk,
  ValidationRejection,
  ValidationFailureCode,
  SignedTransitionResult,
  AuditRecord,
} from "./types.js";
export {
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildRedeemPsbtV3,
  buildTransferPsbtV2,
  RESERVE_ANCHOR_SATS,
  type ResolvedInput,
  type DeployResult,
  type MintResult,
  type RedeemResult,
  type TransferResult,
} from "./builder.js";
export {
  GUARDIAN_AUDIT_DOMAIN,
  canonicalAuditRecordBytes,
  computeGuardianAuditHash,
  verifyGuardianAuditChain,
  InMemorySigningJournal,
  SIGNING_JOURNAL_TTL_MS,
  type GuardianAuditDigestFields,
  type SigningJournalStore,
  type SigningReservation,
} from "./journal.js";
export {
  LocalGuardianTransitionSigner,
  RemoteGuardianTransitionSigner,
  checkRiskPolicy,
  type DurableAuditSink,
  type TransitionSignRequest,
  type TransitionSignOutcome,
  type GuardianTransitionSigner,
  type GuardianRiskPolicy,
} from "./transitionSigner.js";
export {
  InProcessGuardianTransport,
  HttpGuardianTransport,
  stringifyBigint,
  parseBigint,
  extractWitnessSig,
  type GuardianTransport,
  type GuardianSignRequestWire,
  type GuardianSignResponseWire,
  type GuardianSignSuccess,
  type GuardianSignFailure,
  type GuardianHealthWire,
  type GuardianSigningService,
  type GuardianSignServiceRequest,
  type GuardianSignServiceOutcome,
  type InProcessGuardianTransportOptions,
} from "./guardianApi.js";

export {
  // Reading the Cove envelope back off a built or broadcast transaction. The
  // app needs this to follow an unconfirmed vault chain without re-implementing
  // the decode.
  decodeCoveOpReturn,
  decodeCoveOpReturnTx,
} from "./resolve.js";

export { verifyPendingBackingView, MAX_PENDING_ANCESTORS, type PendingBackingParams } from "./pending-backing.js";
