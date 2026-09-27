import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, schema } from "@crclaunch/db";
import { eq } from "drizzle-orm";
import {
  computeGuardianAuditHash,
  type AuditRecord,
  type GuardianAuditDigestFields,
} from "@crclaunch/cove-guardian/v3";
import { PostgresSigningJournal } from "./journal.js";
import { PostgresGuardianAudit } from "./audit.js";

/**
 * Real-Postgres integration test for the durable signer stores (Phase 8 §19-§23).
 * Skips unless COVE_TEST_DATABASE_URL is set (run explicitly in the persistent
 * truth-gate CI alongside a Postgres service). Verifies the signing journal's
 * RESERVED/IDEMPOTENT/CONFLICT semantics + restart survival, and the tamper-evident
 * audit hash chain (canonical hash, linkage, restart survival, signedAt).
 */

const URL = process.env.COVE_TEST_DATABASE_URL;
const NETWORK = "regtest" as const;

function hex32(seed: string): string {
  return `${seed}${"0".repeat(64 - seed.length * 2)}`.slice(0, 64);
}

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    requestId: randomUUID(),
    operation: "MINT",
    tokenId: "ab".repeat(32),
    prevStateHash: "01".repeat(32),
    nextStateHash: "02".repeat(32),
    backingOutpoint: { txid: hex32("cd"), vout: 0 },
    tokenInputOutpoints: [],
    amountAtoms: 8_400_000_000_000_000n,
    grossSats: 49_350n,
    protocolFeeSats: 494n,
    minerFeeSats: 1_000n,
    policyVersion: 3,
    expectedCmr: "e1".repeat(32),
    actualCmr: "e1".repeat(32),
    simplicityResult: "PASS",
    referencePolicyResult: "PASS",
    unsignedTxDigest: "f0".repeat(32),
    network: NETWORK,
    decision: "VALID_TO_SIGN",
    rejectionReason: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Mirror of PostgresGuardianAudit's canonical digest-field projection. */
function toFields(r: AuditRecord): GuardianAuditDigestFields {
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

describe.skipIf(!URL)("Postgres durable signer stores (journal + audit)", () => {
  it("signing journal: RESERVED → IDEMPOTENT → CONFLICT, survives a fresh store, 20-concurrent race → 1 RESERVED", async () => {
    const db = createDb(URL!);
    // Unique outpoint per run (journal's unique index is per network:txid:vout).
    const o1 = {
      network: NETWORK,
      backingTxid: hex32(randomUUID().replace(/-/g, "").slice(0, 64)),
      backingVout: 7,
    };
    const dA = "da".repeat(32);
    const dB = "db".repeat(32);
    const j1 = new PostgresSigningJournal(db);
    expect(await j1.reserve({ ...o1, unsignedTxDigest: dA })).toBe("RESERVED");
    expect(await j1.reserve({ ...o1, unsignedTxDigest: dA })).toBe("IDEMPOTENT");
    expect(await j1.reserve({ ...o1, unsignedTxDigest: dB })).toBe("CONFLICT");

    // Restart survival: a fresh store instance (new object, same DB) still sees it.
    const j2 = new PostgresSigningJournal(db);
    expect(await j2.committedDigest(NETWORK, o1.backingTxid, o1.backingVout)).toBe(dA);
    await j2.markSigned({ ...o1, unsignedTxDigest: dA });
    await db.update(schema.coveV3SigningJournal).set({ expiresAt: new Date(0) })
      .where(eq(schema.coveV3SigningJournal.backingTxid, o1.backingTxid));
    await j2.release({ ...o1, unsignedTxDigest: dA });
    expect(await j2.committedDigest(NETWORK, o1.backingTxid, o1.backingVout)).toBe(dA);
    expect(await j2.reserve({ ...o1, unsignedTxDigest: dB })).toBe("CONFLICT");

    // 20 concurrent distinct digests on a fresh outpoint → exactly 1 RESERVED.
    const o2 = {
      network: NETWORK,
      backingTxid: hex32(randomUUID().replace(/-/g, "").slice(0, 64)),
      backingVout: 9,
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        j1.reserve({ ...o2, unsignedTxDigest: `d${String(i).padStart(2, "0")}`.repeat(32) }),
      ),
    );
    expect(results.filter((r) => r === "RESERVED")).toHaveLength(1);
    expect(results.filter((r) => r === "CONFLICT")).toHaveLength(19);
  });

  it("audit: canonical hash chain, linkage, restart survival, writeAfterSign marks signedAt", async () => {
    const db = createDb(URL!);
    // Reset the chain head for this network (re-runs against a shared DB).
    await db
      .delete(schema.coveV3GuardianAudit)
      .where(eq(schema.coveV3GuardianAudit.network, NETWORK));
    const a1 = new PostgresGuardianAudit(db);

    const r1 = makeRecord({ backingOutpoint: { txid: hex32("c1"), vout: 0 } });
    const r2 = makeRecord({ backingOutpoint: { txid: hex32("c2"), vout: 1 } });
    const { auditHash: h1 } = await a1.writeBeforeSign(r1);
    const { auditHash: h2 } = await a1.writeBeforeSign(r2);

    // Canonical hash: h1 chains from the zero hash; h2 chains from h1.
    expect(h1).toBe(computeGuardianAuditHash("0".repeat(64), toFields(r1)));
    expect(h2).toBe(computeGuardianAuditHash(h1, toFields(r2)));

    // DB linkage: each row's previousAuditHash equals the previous row's auditHash.
    const row1 = (
      await db
        .select()
        .from(schema.coveV3GuardianAudit)
        .where(eq(schema.coveV3GuardianAudit.requestId, r1.requestId))
    )[0]!;
    const row2 = (
      await db
        .select()
        .from(schema.coveV3GuardianAudit)
        .where(eq(schema.coveV3GuardianAudit.requestId, r2.requestId))
    )[0]!;
    expect(row1.previousAuditHash).toBe("0".repeat(64));
    expect(row2.previousAuditHash).toBe(row1.auditHash);
    expect(row1.vaultProfileVersion).toBe("COVE_V3_VAULT_PROFILE_DEV1");

    // Restart survival: a fresh audit store continues the chain from the head.
    const a2 = new PostgresGuardianAudit(db);
    const r3 = makeRecord({ backingOutpoint: { txid: hex32("c3"), vout: 2 } });
    const { auditHash: h3 } = await a2.writeBeforeSign(r3);
    expect(h3).toBe(computeGuardianAuditHash(h2, toFields(r3)));
    expect(await a2.verifiedHeadHash(NETWORK)).toBe(h3);

    // writeAfterSign marks signedAt on the correct row.
    await a2.writeAfterSign(r3, h3);
    const row3 = (
      await db
        .select()
        .from(schema.coveV3GuardianAudit)
        .where(eq(schema.coveV3GuardianAudit.requestId, r3.requestId))
    )[0]!;
    expect(row3.previousAuditHash).toBe(h2);
    expect(row3.signedAt).not.toBeNull();
    expect(row1.signedAt).toBeNull();

    await db
      .update(schema.coveV3GuardianAudit)
      .set({ prevStateHash: "ff".repeat(32) })
      .where(eq(schema.coveV3GuardianAudit.requestId, r2.requestId));
    await expect(a2.verifiedHeadHash(NETWORK)).rejects.toThrow("failed verification");
    await db
      .update(schema.coveV3GuardianAudit)
      .set({ prevStateHash: r2.prevStateHash })
      .where(eq(schema.coveV3GuardianAudit.requestId, r2.requestId));
  });

  it("serializes concurrent audit appends into one chain", async () => {
    const db = createDb(URL!);
    await db
      .delete(schema.coveV3GuardianAudit)
      .where(eq(schema.coveV3GuardianAudit.network, NETWORK));
    const audit = new PostgresGuardianAudit(db);
    const records = Array.from({ length: 12 }, (_, i) =>
      makeRecord({ backingOutpoint: { txid: hex32(`e${i.toString(16)}`), vout: i } }),
    );
    await Promise.all(records.map((record) => audit.writeBeforeSign(record)));
    const rows = await db
      .select()
      .from(schema.coveV3GuardianAudit)
      .where(eq(schema.coveV3GuardianAudit.network, NETWORK));
    expect(rows).toHaveLength(records.length);
    const byPrevious = new Map(rows.map((row) => [row.previousAuditHash, row]));
    expect(byPrevious.size).toBe(rows.length);
    let head = "0".repeat(64);
    for (let i = 0; i < rows.length; i++) {
      const row = byPrevious.get(head);
      expect(row).toBeDefined();
      head = row!.auditHash;
    }
    expect(await audit.verifiedHeadHash(NETWORK)).toBe(head);
  });
});
