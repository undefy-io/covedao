import { createHash } from "node:crypto";

/** Durable audit history and immutable signing results for each candidate. */

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
export function computeGuardianAuditHash(
  previousAuditHash: string,
  fields: GuardianAuditDigestFields,
): string {
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
export function verifyGuardianAuditChain(
  head: { previousAuditHash: string; auditHash: string; fields: GuardianAuditDigestFields }[],
): boolean {
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

export type SigningReservation = "RESERVED" | "IDEMPOTENT";
export interface StoredSigningResult {
  psbtBase64: string;
  resultJson: string;
  auditHash: string;
  txid?: string;
}

/** An unsigned signing lease expires; a produced signature never does. */
export const SIGNING_JOURNAL_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface SigningJournalStore {
  reserve(params: {
    network: string;
    backingTxid: string;
    backingVout: number;
    unsignedTxDigest: string;
  }): Promise<SigningReservation>;
  markSigned(params: {
    network: string;
    backingTxid: string;
    backingVout: number;
    unsignedTxDigest: string;
    signingResult?: StoredSigningResult;
  }): Promise<void>;
  readSigned?(params: {
    network: string;
    backingTxid: string;
    backingVout: number;
    unsignedTxDigest: string;
  }): Promise<StoredSigningResult | null>;
  committedDigest(
    network: string,
    backingTxid: string,
    backingVout: number,
    unsignedTxDigest: string,
  ): Promise<string | null>;
  release(params: {
    network: string;
    backingTxid: string;
    backingVout: number;
    unsignedTxDigest: string;
  }): Promise<void>;
}

export class InMemorySigningJournal implements SigningJournalStore {
  private map = new Map<
    string,
    { digest: string; expiresAt: number; signed: boolean; signingResult?: StoredSigningResult }
  >();
  constructor(private readonly clock: () => number = () => Date.now()) {}

  private now(): number {
    return this.clock();
  }

  async reserve(params: {
    network: string;
    backingTxid: string;
    backingVout: number;
    unsignedTxDigest: string;
  }): Promise<SigningReservation> {
    const key = `${params.network}:${params.backingTxid}:${params.backingVout}:${params.unsignedTxDigest}`;
    const existing = this.map.get(key);
    if (existing !== undefined && (existing.signed || existing.expiresAt > this.now())) {
      return "IDEMPOTENT";
    }
    this.map.set(key, {
      digest: params.unsignedTxDigest,
      expiresAt: this.now() + SIGNING_JOURNAL_TTL_MS,
      signed: false,
    });
    return "RESERVED";
  }

  async markSigned(params: {
    network: string;
    backingTxid: string;
    backingVout: number;
    unsignedTxDigest: string;
    signingResult?: StoredSigningResult;
  }): Promise<void> {
    const key = `${params.network}:${params.backingTxid}:${params.backingVout}:${params.unsignedTxDigest}`;
    const held = this.map.get(key);
    if (!held || held.digest !== params.unsignedTxDigest)
      throw new Error("signing reservation lost");
    held.signed = true;
    held.signingResult ??= params.signingResult;
  }

  async readSigned(params: {
    network: string;
    backingTxid: string;
    backingVout: number;
    unsignedTxDigest: string;
  }): Promise<StoredSigningResult | null> {
    const held = this.map.get(
      `${params.network}:${params.backingTxid}:${params.backingVout}:${params.unsignedTxDigest}`,
    );
    return held?.signed && held.digest === params.unsignedTxDigest
      ? (held.signingResult ?? null)
      : null;
  }

  async committedDigest(
    network: string,
    backingTxid: string,
    backingVout: number,
    unsignedTxDigest: string,
  ): Promise<string | null> {
    const key = `${network}:${backingTxid}:${backingVout}:${unsignedTxDigest}`;
    const existing = this.map.get(key);
    if (existing !== undefined && !existing.signed && existing.expiresAt <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return existing?.digest ?? null;
  }

  async release(params: {
    network: string;
    backingTxid: string;
    backingVout: number;
    unsignedTxDigest: string;
  }): Promise<void> {
    const key = `${params.network}:${params.backingTxid}:${params.backingVout}:${params.unsignedTxDigest}`;
    const existing = this.map.get(key);
    if (existing?.digest === params.unsignedTxDigest && !existing.signed) this.map.delete(key);
  }
}
