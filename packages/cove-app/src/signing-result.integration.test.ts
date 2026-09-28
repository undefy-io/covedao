import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, schema } from "@crclaunch/db";
import { eq } from "drizzle-orm";
import { PostgresSigningJournal } from "./journal.js";

const url = process.env.SUBMISSION_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/submissions_test";
describe.skipIf(!isolated)("durable Guardian signing results on isolated PostgreSQL", () => {
  it("preserves the first signing result across concurrent writers and client restarts", async () => {
    const db = createDb(url!);
    const key = { network: "signing-" + randomUUID(), backingTxid: "ab".repeat(32), backingVout: 1, unsignedTxDigest: "cd".repeat(32) };
    const journal = new PostgresSigningJournal(db);
    expect(await journal.reserve(key)).toBe("RESERVED");
    const first = { psbtBase64: "first-signed-bytes", resultJson: "first-result", auditHash: "ef".repeat(32) };
    await journal.markSigned({ ...key, signingResult: first });
    await Promise.all(Array.from({ length: 10 }, () => journal.markSigned({ ...key,
      signingResult: { ...first, psbtBase64: "later-signature" } })));
    const restarted = new PostgresSigningJournal(createDb(url!));
    expect(await restarted.readSigned(key)).toEqual(first);
    expect(await restarted.readSigned({ ...key, unsignedTxDigest: "ff".repeat(32) })).toBeNull();
    await restarted.release(key);
    expect(await restarted.reserve({ ...key, unsignedTxDigest: "ff".repeat(32) })).toBe("RESERVED");
    await db.delete(schema.coveV3SigningJournal).where(eq(schema.coveV3SigningJournal.network, key.network));
  });
});
