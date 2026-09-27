import { eq, desc, sql } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import {
  computeGuardianAuditHash,
  verifyGuardianAuditChain,
  type GuardianAuditDigestFields,
  type DurableAuditSink,
  type AuditRecord,
} from "@crclaunch/cove-guardian/v3";

/**
 * Postgres durable-before-sign Guardian audit store (§17/§19/§20). Persists a
 * VALIDATED_TO_SIGN record BEFORE any signature and returns its hash-chain
 * hash; writeAfterSign marks it signed. Audit persistence failure throws, which
 * the LocalGuardianTransitionSigner maps to AUDIT_PERSISTENCE_FAILED (no
 * signature).
 */

function digestFields(r: AuditRecord): GuardianAuditDigestFields {
  return {
    requestId: r.requestId,
    operation: r.operation,
    tokenId: r.tokenId,
    backingTxid: r.backingOutpoint.txid,
    backingVout: r.backingOutpoint.vout,
    prevStateHash: r.prevStateHash,
    nextStateHash: r.nextStateHash,
    amountAtoms: r.amountAtoms,
    grossSats: r.grossSats,
    protocolFeeSats: r.protocolFeeSats,
    minerFeeSats: r.minerFeeSats,
    expectedCmr: r.expectedCmr,
    actualCmr: r.actualCmr,
    unsignedTxDigest: r.unsignedTxDigest,
    decision: r.decision,
    rejectionReason: r.rejectionReason,
  };
}

export class PostgresGuardianAudit implements DurableAuditSink {
  constructor(
    readonly db: Database,
    readonly vaultProfileVersion: string = "COVE_V3_VAULT_PROFILE_DEV1",
  ) {}

  /** The latest audit record's hash (all zeros when empty). Also the health probe. */
  async headHash(network: string): Promise<string> {
    const rows = await this.db
      .select({ auditHash: schema.coveV3GuardianAudit.auditHash })
      .from(schema.coveV3GuardianAudit)
      .where(eq(schema.coveV3GuardianAudit.network, network))
      .orderBy(desc(schema.coveV3GuardianAudit.beforeSignPersistedAt))
      .limit(1);
    return rows[0]?.auditHash ?? "0".repeat(64);
  }

  /** Verify every stored link, including disconnected or forked rows. */
  async verifiedHeadHash(network: string): Promise<string> {
    const rows = await this.db
      .select()
      .from(schema.coveV3GuardianAudit)
      .where(eq(schema.coveV3GuardianAudit.network, network));
    const byPrevious = new Map(rows.map((row) => [row.previousAuditHash, row]));
    if (byPrevious.size !== rows.length) throw new Error("Guardian audit chain forks");
    const ordered: Array<{
      previousAuditHash: string;
      auditHash: string;
      fields: GuardianAuditDigestFields;
    }> = [];
    let head = "0".repeat(64);
    while (byPrevious.has(head)) {
      const row = byPrevious.get(head)!;
      ordered.push({
        previousAuditHash: row.previousAuditHash,
        auditHash: row.auditHash,
        fields: {
          requestId: row.requestId,
          operation: row.operation as GuardianAuditDigestFields["operation"],
          tokenId: row.tokenId,
          backingTxid: row.backingTxid,
          backingVout: row.backingVout,
          prevStateHash: row.prevStateHash,
          nextStateHash: row.nextStateHash,
          amountAtoms: row.amountAtoms,
          grossSats: row.grossSats,
          protocolFeeSats: row.protocolFeeSats,
          minerFeeSats: row.minerFeeSats,
          expectedCmr: row.expectedCmr,
          actualCmr: row.actualCmr,
          unsignedTxDigest: row.unsignedTxDigest,
          decision: row.decision as GuardianAuditDigestFields["decision"],
          rejectionReason: row.rejectionReason,
        },
      });
      byPrevious.delete(head);
      head = row.auditHash;
    }
    if (byPrevious.size > 0 || !verifyGuardianAuditChain(ordered)) {
      throw new Error("Guardian audit chain failed verification");
    }
    return head;
  }

  async writeBeforeSign(record: AuditRecord): Promise<{ auditHash: string }> {
    // The head read and append must be one serialized operation across every
    // Guardian process. A transaction-scoped network lock is released on commit
    // or rollback, including process failure.
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('cove_v3_guardian_audit'), hashtext(${record.network}))`,
      );
      const head = await tx
        .select({ auditHash: schema.coveV3GuardianAudit.auditHash })
        .from(schema.coveV3GuardianAudit)
        .where(eq(schema.coveV3GuardianAudit.network, record.network))
        .orderBy(desc(schema.coveV3GuardianAudit.beforeSignPersistedAt))
        .limit(1);
      const previousAuditHash = head[0]?.auditHash ?? "0".repeat(64);
      const auditHash = computeGuardianAuditHash(previousAuditHash, digestFields(record));
      await tx.insert(schema.coveV3GuardianAudit).values({
        network: record.network,
        requestId: record.requestId,
        operation: record.operation,
        tokenId: record.tokenId,
        backingTxid: record.backingOutpoint.txid,
        backingVout: record.backingOutpoint.vout,
        prevStateHash: record.prevStateHash,
        nextStateHash: record.nextStateHash,
        amountAtoms: record.amountAtoms,
        grossSats: record.grossSats,
        protocolFeeSats: record.protocolFeeSats,
        minerFeeSats: record.minerFeeSats,
        policyVersion: record.policyVersion,
        vaultProfileVersion: this.vaultProfileVersion,
        expectedCmr: record.expectedCmr,
        actualCmr: record.actualCmr,
        simplicityResult: record.simplicityResult,
        referencePolicyResult: record.referencePolicyResult,
        unsignedTxDigest: record.unsignedTxDigest,
        decision: record.decision,
        rejectionReason: record.rejectionReason,
        beforeSignPersistedAt: sql`clock_timestamp()`,
        previousAuditHash,
        auditHash,
      });
      return { auditHash };
    });
  }

  async writeAfterSign(record: AuditRecord, _auditHash: string): Promise<void> {
    await this.db
      .update(schema.coveV3GuardianAudit)
      .set({ signedAt: new Date() })
      .where(eq(schema.coveV3GuardianAudit.requestId, record.requestId));
  }
}
