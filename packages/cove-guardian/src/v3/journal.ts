import { createHash } from "node:crypto";

/**
 * Phase 8 durable-before-sign audit + per-backing signing journal (§17-§23).
 * The audit history is a tamper-evident hash chain (`Cove/GuardianAudit/v1`);
 * the signing journal prevents the Guardian from ever signing TWO DIFFERENT
 * successors for the same backing outpoint. Both survive process restart.
 */

export const GUARDIAN_AUDIT_DOMAIN = "Cove/GuardianAudit/v1";

/** Canonical audit fields (subset) used for the tamper-evident hash chain. */
export interface GuardianAuditDigestFields {
  requestId: string;
  operation: "MINT" | "REDEEM";
  tokenId: string;
  backingTxid: string;
  backingVout: number;
  prevStateHash: string;
  nextStateHash: string;
  amountAtoms: bigint;
  grossSats: bigint;
  protocolFeeSats: bigint;
  minerFeeSats: bigint;
  expectedCmr: string;
  actualCmr: string;
  unsignedTxDigest: string;
  decision: "VALID_TO_SIGN" | "REJECTED";
  rejectionReason: string | null;
}

function h64(s: string): Buffer {
  return Buffer.from(s.replace(/^0x/, ""), "hex");
}
function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n, 0);
  return b;
}
function str(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length, 0);
  return Buffer.concat([len, b]);
}

/** Deterministic canonical bytes (endian-frozen; never JS property order). */
export function canonicalAuditRecordBytes(f: GuardianAuditDigestFields): Buffer {
  return Buffer.concat([
    str(f.requestId),
    str(f.operation),
    h64(f.tokenId),
    h64(f.backingTxid),
    u64(BigInt(f.backingVout)),
    h64(f.prevStateHash),
    h64(f.nextStateHash),
    u64(f.amountAtoms),
    u64(f.grossSats),
    u64(f.protocolFeeSats),
    u64(f.minerFeeSats),
    h64(f.expectedCmr),
    h64(f.actualCmr),
    h64(f.unsignedTxDigest),
    str(f.decision),
    str(f.rejectionReason ?? ""),
  ]);
}

/** H(domain || previousAuditHash || canonicalBytes). */
export function computeGuardianAuditHash(previousAuditHash: string, fields: GuardianAuditDigestFields): string {
  const domain = Buffer.from(GUARDIAN_AUDIT_DOMAIN, "utf8");
  return createHash("sha256")
    .update(domain)
    .update(h64(previousAuditHash || "0".repeat(64)))
    .update(canonicalAuditRecordBytes(fields))
    .digest("hex");
}

/**
 * Verify a hash chain from a list of (previousAuditHash, auditHash, fields).
 * Returns false unless every link's recomputed hash equals its recorded
 * auditHash AND each link's previousAuditHash equals the prior link's auditHash
 * (first link must chain from the zero hash). §C10.
 */
export function verifyGuardianAuditChain(head: { previousAuditHash: string; auditHash: string; fields: GuardianAuditDigestFields }[]): boolean {
  for (let i = 0; i < head.length; i++) {
    const link = head[i]!;
    const expected = computeGuardianAuditHash(link.previousAuditHash, link.fields);
    if (expected !== link.auditHash) return false;
    if (i === 0) {
      if (link.previousAuditHash !== "0".repeat(64)) return false;
    } else if (link.previousAuditHash !== head[i - 1]!.auditHash) {
      return false;
    }
  }
  return true;
}

export type SigningReservation = "RESERVED" | "IDEMPOTENT" | "CONFLICT";

/** An unsigned signing lease expires; a produced signature never does. */
export const SIGNING_JOURNAL_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Durable per-backing-outpoint signing journal (double-sign protection). */
export interface SigningJournalStore {
  /**
   * Reserve a backing outpoint for `unsignedTxDigest`. CONFLICT means a
   * DIFFERENT digest was already committed (never sign); IDEMPOTENT means the
   * SAME digest was already committed (may recover the same signing result).
   * Only an unsigned reservation whose TTL has elapsed can be re-reserved.
   */
  reserve(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string }): Promise<SigningReservation>;
  /** Make a produced signature's conflict barrier permanent before returning it. */
  markSigned(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string }): Promise<void>;
  committedDigest(network: string, backingTxid: string, backingVout: number): Promise<string | null>;
  /**
   * Release an unsigned reservation if it still matches `unsignedTxDigest`.
   * A produced signature's barrier cannot be released through this method.
   */
  release(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string }): Promise<void>;
}

/** In-memory journal (tests). A Map keyed by network:txid:vout. */
export class InMemorySigningJournal implements SigningJournalStore {
  private map = new Map<string, { digest: string; expiresAt: number; signed: boolean }>();
  constructor(private readonly clock: () => number = () => Date.now()) {}

  private now(): number {
    return this.clock();
  }

  async reserve(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string }): Promise<SigningReservation> {
    const key = `${params.network}:${params.backingTxid}:${params.backingVout}`;
    const existing = this.map.get(key);
    if (existing !== undefined && (existing.signed || existing.expiresAt > this.now())) {
      return existing.digest === params.unsignedTxDigest ? "IDEMPOTENT" : "CONFLICT";
    }
    this.map.set(key, { digest: params.unsignedTxDigest, expiresAt: this.now() + SIGNING_JOURNAL_TTL_MS, signed: false });
    return "RESERVED";
  }

  async markSigned(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string }): Promise<void> {
    const key = `${params.network}:${params.backingTxid}:${params.backingVout}`;
    const held = this.map.get(key);
    if (!held || held.digest !== params.unsignedTxDigest) throw new Error("signing reservation lost");
    held.signed = true;
  }

  async committedDigest(network: string, backingTxid: string, backingVout: number): Promise<string | null> {
    const key = `${network}:${backingTxid}:${backingVout}`;
    const existing = this.map.get(key);
    if (existing !== undefined && !existing.signed && existing.expiresAt <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return existing?.digest ?? null;
  }

  async release(params: { network: string; backingTxid: string; backingVout: number; unsignedTxDigest: string }): Promise<void> {
    const key = `${params.network}:${params.backingTxid}:${params.backingVout}`;
    const existing = this.map.get(key);
    if (existing?.digest === params.unsignedTxDigest && !existing.signed) this.map.delete(key);
  }
}
