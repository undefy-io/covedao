import * as bitcoin from "bitcoinjs-lib";
import { randomUUID } from "node:crypto";
import { stateHashV2, type CoveCanonicalView } from "@crclaunch/cove-covenant";
import { buildBackingVaultV3, tapleafHash, type VaultRecoveryProfile } from "@crclaunch/cove-vault";
import { COVE_POLICY_V3 } from "@crclaunch/cove-wire";
import { validateMintTransitionV3, validateRedeemTransitionV3 } from "./validate.js";
import { unsignedTxDigest, decodeCoveOpReturn } from "./resolve.js";
import { verifyVaultExecutionSignature } from "./signer.js";
import type { GuardianSigningBackend } from "./custody.js";
import type { FundingInputChecker } from "./funding.js";
import type { SigningJournalStore } from "./journal.js";
import type { GuardianTransport, GuardianSignRequestWire } from "./guardianApi.js";
import { parseBigint } from "./guardianApi.js";
import type {
  AuditRecord,
  GuardianV3Network,
  MintAnalysis,
  RedeemAnalysis,
  SignedTransitionResult,
} from "./types.js";

/**
 * Phase 8 Guardian service boundary (§12-§15, §17-§24). A `GuardianTransitionSigner`
 * is the application-facing signing boundary: it only signs MINT/REDEEM (never
 * arbitrary data), and the LOCAL implementation persists a VALIDATED_TO_SIGN
 * audit + reserves the backing outpoint BEFORE producing any signature — audit
 * failure aborts the signature, and a conflicting digest is refused.
 */

export interface DurableAuditSink {
  /** MUST be durably persisted before any signature; rejection aborts signing. */
  writeBeforeSign(record: AuditRecord): Promise<{ auditHash: string }>;
  writeAfterSign(record: AuditRecord, auditHash: string): Promise<void>;
}

export interface TransitionSignRequest {
  psbt: bitcoin.Psbt;
  view: CoveCanonicalView;
  network: GuardianV3Network;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  feeScript: Buffer;
  maxMinerFeeSats?: bigint;
  /** Protocol fee schedule (bps). Defaults to the development COVE_FEE_CONFIG. */
  buyFeeBps?: bigint;
  redeemFeeBps?: bigint;
  /**
   * Flat fee components. These MUST be forwarded whenever the caller's schedule
   * differs from COVE_FEE_CONFIG: the builder and this validator each fall back
   * to the development default independently, so an unforwarded value makes the
   * two disagree and every transition is rejected.
   */
  buyFeeFlatSats?: bigint;
  /** Creator share of a mint, bps of the curve price. */
  creatorFeeBps?: bigint;
  redeemFeeFlatSats?: bigint;
  /** Ticker the advisory crc-20 discovery envelope must carry, if present (§D1). */
  discoveryTicker?: string;
  /**
   * Funding-input checks (confirmed, no tokens). The local signer uses this;
   * the remote Guardian ignores it and runs its own from its own Core and DB.
   */
  fundingChecker: FundingInputChecker;
}

export type TransitionSignOutcome =
  | SignedTransitionResult
  | { ok: false; reason: string; detail: string; audit: AuditRecord | null };

/**
 * Phase 8 operational risk policy (§25/§26). Enforced INSIDE the signer so a
 * compromised web/API cannot bypass caps. These are operational brakes, not
 * protocol semantics.
 */
export interface GuardianRiskPolicy {
  maxGrossSats: bigint;
  /**
   * Largest single mint, in ATOMS. A per-mint ceiling keeps one buyer from
   * taking the whole curve in one transaction.
   */
  maxMintAtoms: bigint;
  /**
   * Smallest single mint, in sats of curve value.
   *
   * The protocol fee has a flat component, so a mint far below this would pay
   * far more in fees than it buys — a thousand tiny mints cost a thousand flat
   * fees while raising almost nothing. A floor keeps the fee proportionate and
   * stops the transaction count running away, which matters because the vault
   * can only be spent a bounded number of times per block.
   */
  minMintGrossSats: bigint;
  maxRedeemPayoutSats: bigint;
  maxBackingSats: bigint;
  maxMinerFeeSats: bigint;
  /** Canary token allowlist (hex). Enforced only when enforceTokenAllowlist is true. */
  allowedTokenIds: string[];
  /** True = enforce the token allowlist (mainnet canary). False = any token (regtest/dev). */
  enforceTokenAllowlist: boolean;
}

export function checkRiskPolicy(policy: GuardianRiskPolicy, analysis: MintAnalysis | RedeemAnalysis, operation: "MINT" | "REDEEM"): string | null {
  const tokenId = analysis.tokenId.toString("hex");
  // Fail closed: an empty allowlist (or a token not in it) means NOBODY.
  if (policy.enforceTokenAllowlist && !policy.allowedTokenIds.includes(tokenId)) {
    return `token ${tokenId} is not in the canary allowlist`;
  }
  if (analysis.grossSats > policy.maxGrossSats) return `gross ${analysis.grossSats} exceeds cap ${policy.maxGrossSats}`;
  if (operation === "MINT") {
    const amount = (analysis as MintAnalysis).amountAtoms;
    if (amount > policy.maxMintAtoms) {
      return `mint of ${amount / 100_000_000n} tokens exceeds the per-mint limit of ${policy.maxMintAtoms / 100_000_000n}`;
    }
    if (analysis.grossSats < policy.minMintGrossSats) {
      return `mint of ${analysis.grossSats} sats is below the minimum of ${policy.minMintGrossSats}`;
    }
  }
  if (analysis.nextState.backingSats > policy.maxBackingSats) return `next backing ${analysis.nextState.backingSats} exceeds cap ${policy.maxBackingSats}`;
  if (analysis.minerFeeSats > policy.maxMinerFeeSats) return `miner fee ${analysis.minerFeeSats} exceeds cap ${policy.maxMinerFeeSats}`;
  if (operation === "REDEEM" && (analysis as RedeemAnalysis).netPayoutSats > policy.maxRedeemPayoutSats) {
    return `redeem payout exceeds cap ${policy.maxRedeemPayoutSats}`;
  }
  return null;
}

export interface GuardianTransitionSigner {
  signMint(req: TransitionSignRequest): Promise<TransitionSignOutcome>;
  signRedeem(req: TransitionSignRequest): Promise<TransitionSignOutcome>;
  health(): Promise<{ reachable: boolean; reason?: string }>;
}

function buildAuditRecord(params: {
  operation: "MINT" | "REDEEM";
  network: GuardianV3Network;
  psbt: bitcoin.Psbt;
  analysis: MintAnalysis | RedeemAnalysis;
  expectedCmr: string | null;
  actualCmr: string | null;
  simplicityResult: "PASS" | "FAIL";
  decision: "VALID_TO_SIGN" | "REJECTED";
  rejectionReason: string | null;
}): AuditRecord {
  const a = params.analysis;
  const tokenId = a.tokenId.toString("hex");
  const prev = "prevStateHash" in a ? a.currentState : a.currentState;
  return {
    requestId: randomUUID(),
    operation: params.operation,
    tokenId,
    prevStateHash: stateHashV2(prev),
    nextStateHash: stateHashV2(a.nextState),
    backingOutpoint: a.backingOutpoint,
    tokenInputOutpoints: params.operation === "REDEEM" ? (a as RedeemAnalysis).tokenInputOutpoints : [],
    amountAtoms: params.operation === "MINT" ? (a as MintAnalysis).amountAtoms : (a as RedeemAnalysis).redeemAmountAtoms,
    grossSats: a.grossSats,
    protocolFeeSats: a.protocolFeeSats,
    minerFeeSats: a.minerFeeSats,
    policyVersion: COVE_POLICY_V3,
    expectedCmr: params.expectedCmr ?? "",
    actualCmr: params.actualCmr ?? "",
    simplicityResult: params.simplicityResult,
    referencePolicyResult: "PASS",
    unsignedTxDigest: unsignedTxDigest(params.psbt),
    network: params.network,
    decision: params.decision,
    rejectionReason: params.rejectionReason,
    timestamp: new Date().toISOString(),
  };
}

/** Local (non-mainnet) signer: durable-before-sign audit + journal + sign. */
export class LocalGuardianTransitionSigner implements GuardianTransitionSigner {
  constructor(
    private readonly signer: GuardianSigningBackend,
    private readonly journal: SigningJournalStore,
    private readonly audit: DurableAuditSink,
    private readonly riskPolicy: GuardianRiskPolicy,
  ) {}

  async signMint(req: TransitionSignRequest): Promise<TransitionSignOutcome> {
    return this.sign(req, "MINT");
  }
  async signRedeem(req: TransitionSignRequest): Promise<TransitionSignOutcome> {
    return this.sign(req, "REDEEM");
  }
  async health(): Promise<{ reachable: boolean }> {
    return { reachable: true };
  }

  private async sign(req: TransitionSignRequest, op: "MINT" | "REDEEM"): Promise<TransitionSignOutcome> {
    const guardianXOnly = await this.signer.xOnlyPubkey();
    const validate = await (op === "MINT"
      ? validateMintTransitionV3({ ...req, guardianXOnly })
      : validateRedeemTransitionV3({ ...req, guardianXOnly }));
    if (!validate.ok) {
      return { ok: false, reason: validate.reason, detail: validate.detail, audit: null };
    }
    const analysis = validate.analysis;

    // 0. Risk policy (operational brake) enforced BEFORE audit/sign.
    const risk = checkRiskPolicy(this.riskPolicy, analysis, op);
    if (risk) {
      return { ok: false, reason: "RISK_POLICY_REJECTED", detail: risk, audit: null };
    }

    const record = buildAuditRecord({
      operation: op,
      network: req.network,
      psbt: req.psbt,
      analysis,
      expectedCmr: validate.simplicity.expectedCmr,
      actualCmr: validate.simplicity.actualCmr,
      simplicityResult: validate.simplicity.result,
      decision: "VALID_TO_SIGN",
      rejectionReason: null,
    });

    // 1. Durable-before-sign audit. Failure → NO signature.
    let receipt: { auditHash: string };
    try {
      receipt = await this.audit.writeBeforeSign(record);
    } catch (e) {
      return { ok: false, reason: "AUDIT_PERSISTENCE_FAILED", detail: (e as Error).message, audit: record };
    }

    // 2. Reserve the backing outpoint (double-sign protection).
    const reservation = await this.journal.reserve({
      network: req.network,
      backingTxid: record.backingOutpoint.txid,
      backingVout: record.backingOutpoint.vout,
      unsignedTxDigest: record.unsignedTxDigest,
    });
    if (reservation === "CONFLICT") {
      return { ok: false, reason: "BACKING_ALREADY_SIGNED", detail: "backing outpoint already signed with a different digest", audit: record };
    }

    // 3. Sign (script-path execution leaf).
    const prevVault = buildBackingVaultV3({
      state: analysis.currentState,
      guardianXOnly,
      recoveryKeyXOnly: req.recoveryKeyXOnly,
      recoveryProfile: req.recoveryProfile,
      network: req.network === "regtest" ? bitcoin.networks.regtest : req.network === "mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet,
    });
    const leaf = op === "MINT" ? prevVault.mintLeaf : prevVault.redeemLeaf;
    const control = op === "MINT" ? prevVault.mintControlBlock : prevVault.redeemControlBlock;
    let signatureProduced = false;
    try {
      await this.signer.signVaultExecutionLeaf(req.psbt, 0, leaf, control);
      signatureProduced = true;
      await this.journal.markSigned({
        network: req.network,
        backingTxid: record.backingOutpoint.txid,
        backingVout: record.backingOutpoint.vout,
        unsignedTxDigest: record.unsignedTxDigest,
      });
    } catch (e) {
      // §C6: release the reservation we just committed so a throwable signing
      // step (e.g. a missing witnessUtxo or an unsupported PSBT version) does
      // NOT permanently brick the backing outpoint.
      if (!signatureProduced && reservation === "RESERVED") {
        await this.journal.release({
          network: req.network,
          backingTxid: record.backingOutpoint.txid,
          backingVout: record.backingOutpoint.vout,
          unsignedTxDigest: record.unsignedTxDigest,
        });
      }
      return { ok: false, reason: "SIGNING_FAILED", detail: (e as Error).message, audit: record };
    }

    // 4. Durable after-sign update. A failure here does NOT undo the signature or
    // release the journal reservation (§34): the critical property is that we
    // NEVER produce a second signature because post-sign logging failed. Surface
    // the failure so operators can reconcile the audit (do not silently swallow).
    let auditFinalizationError: string | null = null;
    try {
      await this.audit.writeAfterSign(record, receipt.auditHash);
    } catch (e) {
      auditFinalizationError = (e as Error).message;
      console.error(`SIGNED_BUT_AUDIT_FINALIZATION_FAILED: ${op} ${record.backingOutpoint.txid}:${record.backingOutpoint.vout} — ${auditFinalizationError}`);
    }

    return {
      ok: true,
      operation: op,
      tokenId: record.tokenId,
      prevStateHash: record.prevStateHash,
      nextStateHash: record.nextStateHash,
      expectedCmr: record.expectedCmr,
      actualCmr: record.actualCmr,
      simplicityResult: record.simplicityResult,
      referencePolicyResult: "PASS",
      backingOutpoint: record.backingOutpoint,
      signedInputIndex: 0,
      audit: record,
      auditFinalizationError,
    };
  }
}

/**
 * Production remote signer: a functional client over a `GuardianTransport`
 * (HTTP in production, in-process in tests). It authenticates via the transport,
 * enforces a timeout, parses the typed result, verifies the service profile hash
 * + Guardian x-only key, INDEPENDENTLY verifies the returned signature against
 * the client's own PSBT, then applies the committed witness. No local fallback.
 */
export class RemoteGuardianTransitionSigner implements GuardianTransitionSigner {
  constructor(
    private readonly transport: GuardianTransport,
    private readonly expectedProfileHash: string,
    private readonly expectedGuardianXOnly: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async signMint(req: TransitionSignRequest): Promise<TransitionSignOutcome> {
    return this.sign(req, "MINT");
  }
  async signRedeem(req: TransitionSignRequest): Promise<TransitionSignOutcome> {
    return this.sign(req, "REDEEM");
  }
  async health(): Promise<{ reachable: boolean; reason?: string }> {
    try {
      const h = await this.transport.health();
      if (!h.reachable) return { reachable: false, reason: "guardian unreachable" };
      if (h.profileHash !== this.expectedProfileHash) return { reachable: false, reason: `GUARDIAN_PROFILE_MISMATCH: ${h.profileHash.slice(0, 8)}…` };
      if (h.guardianXOnly.toLowerCase() !== this.expectedGuardianXOnly.toLowerCase()) return { reachable: false, reason: "GUARDIAN_KEY_MISMATCH" };
      return { reachable: true };
    } catch (e) {
      return { reachable: false, reason: (e as Error).message };
    }
  }

  private async sign(req: TransitionSignRequest, op: "MINT" | "REDEEM"): Promise<TransitionSignOutcome> {
    const envelope = decodeCoveOpReturn(req.psbt);
    if (!("tokenId" in envelope)) {
      return { ok: false, reason: "BAD_PSBT", detail: "PSBT envelope is not a MINT/REDEEM", audit: null };
    }
    const tokenId = Buffer.from(envelope.tokenId).toString("hex");
    const wire: GuardianSignRequestWire = {
      requestId: randomUUID(),
      operation: op,
      network: req.network,
      psbtBase64: req.psbt.toBase64(),
      tokenId,
    };

    let response;
    try {
      response = await this.withTimeout(this.transport.sign(wire), this.timeoutMs);
    } catch (e) {
      const code = (e as Error).name === "TimeoutError" || (e as Error).message.includes("timeout")
        ? "GUARDIAN_TIMEOUT"
        : "REMOTE_GUARDIAN_UNAVAILABLE";
      return { ok: false, reason: code, detail: (e as Error).message, audit: null };
    }

    if (!response.ok) {
      return { ok: false, reason: response.reason, detail: response.detail, audit: null };
    }

    // Verify the service identity + profile, then independently verify the signature.
    if (response.profileHash !== this.expectedProfileHash) {
      return { ok: false, reason: "GUARDIAN_PROFILE_MISMATCH", detail: "service profile hash differs from the committed profile", audit: null };
    }
    if (response.guardianXOnly.toLowerCase() !== this.expectedGuardianXOnly.toLowerCase()) {
      return { ok: false, reason: "GUARDIAN_KEY_MISMATCH", detail: "service Guardian key differs from the committed profile", audit: null };
    }

    const sig = Buffer.from(response.sigHex, "hex");
    try {
      this.independentlyVerifySignature(req.psbt, sig);
    } catch (e) {
      return { ok: false, reason: "SIGNATURE_VERIFICATION_FAILED", detail: (e as Error).message, audit: null };
    }

    // Apply the committed witness to the client's own PSBT (input 0).
    const signedPsbt = bitcoin.Psbt.fromBase64(response.signedPsbtBase64);
    const witness = signedPsbt.data.inputs[0]!.finalScriptWitness;
    if (!witness) return { ok: false, reason: "SIGNATURE_VERIFICATION_FAILED", detail: "service returned no final witness", audit: null };
    req.psbt.updateInput(0, { finalScriptWitness: witness });

    return parseBigint<SignedTransitionResult>(response.resultJson);
  }

  /** Recompute the sighash over the client's OWN PSBT and verify the signature. */
  private independentlyVerifySignature(psbt: bitcoin.Psbt, sig: Buffer): void {
    const tapLeaf = psbt.data.inputs[0]!.tapLeafScript?.[0];
    if (!tapLeaf) throw new Error("SIGNATURE_VERIFICATION_FAILED: no tap leaf script on input 0");
    const leaf = { script: tapLeaf.script, tapleafHash: tapleafHash(tapLeaf.script, tapLeaf.leafVersion) };
    verifyVaultExecutionSignature(psbt, 0, leaf, sig, Buffer.from(this.expectedGuardianXOnly, "hex"));
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("guardian request timeout")), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
