import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@crclaunch/db";
import { claimCrcBuildSession, createCrcBuildSession, getCrcBuildSession, markCrcBuildReady } from "./crc-session";

const url = process.env.CRC_READ_TEST_DATABASE_URL;
const isolated = !!url && (() => { const u = new URL(url); return u.hostname === "127.0.0.1" && u.port === "5435" && u.pathname === "/crc_test"; })();
const db = isolated ? createDb(url!) : undefined;
const network = "signet";
const prefix = `web-session-${randomUUID()}`;

describe.skipIf(!isolated)("CRC build sessions on isolated PostgreSQL", () => {
  afterAll(async () => { await db!.execute(sql`delete from cove_crc_build_sessions where idempotency_key like ${`${prefix}%`}`); });

  it("reuses only the exact same request and binds the unsigned PSBT", async () => {
    const input = {
      network, operation: "mint-buy" as const, deploymentTxid: "a".repeat(64),
      idempotencyKey: `${prefix}-same`, requestHash: "b".repeat(64), unsignedTxDigest: "c".repeat(64),
      psbtBase64: "cHNidP8=", walletScriptHex: "0014" + "1".repeat(40),
      tokenScriptHex: "5120" + "2".repeat(64), trustedJson: { vaultOutpoint: `${"d".repeat(64)}:1` },
    };
    const first = await createCrcBuildSession(db!, input);
    expect((await createCrcBuildSession(db!, input)).id).toBe(first.id);
    await expect(createCrcBuildSession(db!, { ...input, requestHash: "e".repeat(64) })).rejects.toThrow(/idempotency/i);
    expect((await getCrcBuildSession(db!, network, first.id))?.unsignedTxDigest).toBe(input.unsignedTxDigest);
  });

  it("claims signing atomically and saves raw before broadcast", async () => {
    const input = {
      network, operation: "deploy" as const, deploymentTxid: null,
      idempotencyKey: `${prefix}-claim`, requestHash: "b".repeat(64), unsignedTxDigest: "c".repeat(64),
      psbtBase64: "cHNidP8=", walletScriptHex: "0014" + "1".repeat(40),
      tokenScriptHex: "5120" + "2".repeat(64), trustedJson: { launchSaltHex: "f".repeat(64) },
    };
    const session = await createCrcBuildSession(db!, input);
    const signedHash = "e".repeat(64);
    const claims = await Promise.all([
      claimCrcBuildSession(db!, network, session.id, signedHash),
      claimCrcBuildSession(db!, network, session.id, signedHash),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await markCrcBuildReady(db!, network, session.id, "00", "f".repeat(64));
    expect(await getCrcBuildSession(db!, network, session.id)).toMatchObject({ status: "READY", signedRawHex: "00", txid: "f".repeat(64) });
  });
});
