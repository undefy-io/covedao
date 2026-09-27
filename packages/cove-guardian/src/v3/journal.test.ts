import { describe, expect, it } from "vitest";
import {
  computeGuardianAuditHash,
  canonicalAuditRecordBytes,
  verifyGuardianAuditChain,
  InMemorySigningJournal,
  SIGNING_JOURNAL_TTL_MS,
  type GuardianAuditDigestFields,
} from "./journal.js";

function fields(overrides: Partial<GuardianAuditDigestFields> = {}): GuardianAuditDigestFields {
  return {
    requestId: "req-1",
    operation: "MINT",
    tokenId: "aa".repeat(32),
    backingTxid: "bb".repeat(32),
    backingVout: 1,
    prevStateHash: "cc".repeat(32),
    nextStateHash: "dd".repeat(32),
    amountAtoms: 50_000_000n * 100_000_000n,
    grossSats: 47_950n,
    protocolFeeSats: 480n,
    minerFeeSats: 1_000n,
    expectedCmr: "7fb27adf2db5458882daf976ba9325815f111b2f3b16eedb72e75f96de4269b2",
    actualCmr: "7fb27adf2db5458882daf976ba9325815f111b2f3b16eedb72e75f96de4269b2",
    unsignedTxDigest: "ee".repeat(32),
    decision: "VALID_TO_SIGN",
    rejectionReason: null,
    ...overrides,
  };
}

describe("Guardian durable audit + signing journal (§17-§23)", () => {
  it("audit hash is deterministic and endian-frozen (no property order)", () => {
    const f = fields();
    const a = computeGuardianAuditHash("0".repeat(64), f);
    const b = computeGuardianAuditHash("0".repeat(64), { ...f });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    // Any field mutation changes the hash.
    expect(computeGuardianAuditHash("0".repeat(64), fields({ amountAtoms: 1n }))).not.toBe(a);
    expect(canonicalAuditRecordBytes(f).equals(canonicalAuditRecordBytes({ ...f }))).toBe(true);
  });

  it("hash chain links previous audit hash", () => {
    const f1 = fields();
    const h1 = computeGuardianAuditHash("0".repeat(64), f1);
    const f2 = fields({ requestId: "req-2" });
    const h2 = computeGuardianAuditHash(h1, f2);
    expect(h2).not.toBe(h1);
    expect(h2).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signing journal: first digest wins; conflicting digest is rejected; same digest idempotent", async () => {
    const j = new InMemorySigningJournal();
    const outpoint = { network: "regtest", backingTxid: "bb".repeat(32), backingVout: 1 };
    expect(await j.reserve({ ...outpoint, unsignedTxDigest: "11".repeat(32) })).toBe("RESERVED");
    expect(await j.reserve({ ...outpoint, unsignedTxDigest: "22".repeat(32) })).toBe("CONFLICT");
    expect(await j.reserve({ ...outpoint, unsignedTxDigest: "11".repeat(32) })).toBe("IDEMPOTENT");
    expect(await j.committedDigest(outpoint.network, outpoint.backingTxid, outpoint.backingVout)).toBe("11".repeat(32));
  });

  it("signing journal: 20 concurrent distinct digests → exactly one RESERVED, 19 CONFLICT", async () => {
    const j = new InMemorySigningJournal();
    const outpoint = { network: "regtest", backingTxid: "cc".repeat(32), backingVout: 3 };
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => j.reserve({ ...outpoint, unsignedTxDigest: i.toString(16).padStart(64, "0") })),
    );
    expect(results.filter((r) => r === "RESERVED")).toHaveLength(1);
    expect(results.filter((r) => r === "CONFLICT")).toHaveLength(19);
  });

  it("verifyGuardianAuditChain validates hashes + chaining (§C10)", () => {
    const f1 = fields();
    const h1 = computeGuardianAuditHash("0".repeat(64), f1);
    const f2 = fields({ requestId: "req-2" });
    const h2 = computeGuardianAuditHash(h1, f2);

    expect(verifyGuardianAuditChain([
      { previousAuditHash: "0".repeat(64), auditHash: h1, fields: f1 },
      { previousAuditHash: h1, auditHash: h2, fields: f2 },
    ])).toBe(true);

    // A tampered recorded auditHash must fail (previously the predicate was dead).
    expect(verifyGuardianAuditChain([
      { previousAuditHash: "0".repeat(64), auditHash: "00".repeat(32), fields: f1 },
    ])).toBe(false);

    // A broken chain (previousAuditHash != prior auditHash) must fail.
    expect(verifyGuardianAuditChain([
      { previousAuditHash: "0".repeat(64), auditHash: h1, fields: f1 },
      { previousAuditHash: "ff".repeat(32), auditHash: h2, fields: f2 },
    ])).toBe(false);

    // The first link must start from the zero hash.
    expect(verifyGuardianAuditChain([
      { previousAuditHash: "aa".repeat(32), auditHash: h1, fields: f1 },
    ])).toBe(false);
  });

  it("release un-bricks a reservation so a new digest can reserve (§C1/§C6)", async () => {
    const j = new InMemorySigningJournal();
    const outpoint = { network: "regtest", backingTxid: "dd".repeat(32), backingVout: 1 };
    expect(await j.reserve({ ...outpoint, unsignedTxDigest: "11".repeat(32) })).toBe("RESERVED");
    await j.release({ ...outpoint, unsignedTxDigest: "11".repeat(32) });
    expect(await j.committedDigest(outpoint.network, outpoint.backingTxid, outpoint.backingVout)).toBeNull();
    expect(await j.reserve({ ...outpoint, unsignedTxDigest: "22".repeat(32) })).toBe("RESERVED");
  });

  it("an expired reservation self-heals (re-reservable with a new digest) (§C1)", async () => {
    let t = 0;
    const j = new InMemorySigningJournal(() => t);
    const outpoint = { network: "regtest", backingTxid: "ee".repeat(32), backingVout: 1 };
    expect(await j.reserve({ ...outpoint, unsignedTxDigest: "11".repeat(32) })).toBe("RESERVED");
    // Before expiry, a different digest is a conflict.
    expect(await j.reserve({ ...outpoint, unsignedTxDigest: "22".repeat(32) })).toBe("CONFLICT");
    // After expiry, a different digest re-reserves.
    t = SIGNING_JOURNAL_TTL_MS + 1;
    expect(await j.reserve({ ...outpoint, unsignedTxDigest: "22".repeat(32) })).toBe("RESERVED");
    expect(await j.committedDigest(outpoint.network, outpoint.backingTxid, outpoint.backingVout)).toBe("22".repeat(32));
  });

  it("a signed reservation never expires or releases", async () => {
    let t = 0;
    const j = new InMemorySigningJournal(() => t);
    const outpoint = { network: "regtest", backingTxid: "fa".repeat(32), backingVout: 1 };
    const first = { ...outpoint, unsignedTxDigest: "11".repeat(32) };
    expect(await j.reserve(first)).toBe("RESERVED");
    await j.markSigned(first);
    t = SIGNING_JOURNAL_TTL_MS + 1;
    await j.release(first);
    expect(await j.committedDigest(outpoint.network, outpoint.backingTxid, outpoint.backingVout)).toBe(first.unsignedTxDigest);
    expect(await j.reserve({ ...outpoint, unsignedTxDigest: "22".repeat(32) })).toBe("CONFLICT");
  });
});
