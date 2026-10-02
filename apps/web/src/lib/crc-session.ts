import { AppError } from "@crclaunch/cove-app";
import { randomUUID } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";

export type CrcBuildOperation =
  "deploy" | "mint-buy" | "inventory-buy" | "sell" | "transfer" | "listing" | "purchase" | "cancel";

export type NewCrcBuildSession = {
  network: string;
  operation: CrcBuildOperation;
  deploymentTxid: string | null;
  idempotencyKey: string;
  requestHash: string;
  unsignedTxDigest: string;
  psbtBase64: string;
  walletScriptHex: string;
  tokenScriptHex: string;
  trustedJson: Record<string, unknown>;
};

export async function getCrcBuildSession(db: Database, network: string, id: string) {
  const [row] = await db
    .select()
    .from(schema.crcSessions)
    .where(and(eq(schema.crcSessions.network, network), eq(schema.crcSessions.id, id)))
    .limit(1);
  return row ?? null;
}

export async function findCrcBuildSessionByKey(db: Database, network: string, key: string) {
  if (key.length < 1 || key.length > 128) throw new Error("invalid CRC idempotency key");
  const [row] = await db
    .select()
    .from(schema.crcSessions)
    .where(and(eq(schema.crcSessions.network, network), eq(schema.crcSessions.idempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

export async function createCrcBuildSession(db: Database, input: NewCrcBuildSession) {
  if (
    !/^[0-9a-f]{64}$/.test(input.requestHash) ||
    !/^[0-9a-f]{64}$/.test(input.unsignedTxDigest) ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 128
  ) {
    throw new Error("invalid CRC build session identity");
  }
  await db
    .insert(schema.crcSessions)
    .values(input)
    .onConflictDoNothing({
      target: [schema.crcSessions.network, schema.crcSessions.idempotencyKey],
    });
  const [row] = await db
    .select()
    .from(schema.crcSessions)
    .where(
      and(
        eq(schema.crcSessions.network, input.network),
        eq(schema.crcSessions.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.requestHash !== input.requestHash ||
    row.operation !== input.operation ||
    row.walletScriptHex !== input.walletScriptHex ||
    row.tokenScriptHex !== input.tokenScriptHex
  ) {
    throw new AppError("IDEMPOTENCY_CONFLICT", "CRC build idempotency conflict");
  }
  return row;
}

export async function claimCrcBuildSession(
  db: Database,
  network: string,
  id: string,
  signedPsbtSha256: string,
) {
  if (!/^[0-9a-f]{64}$/.test(signedPsbtSha256)) throw new Error("invalid signed PSBT hash");
  const [row] = await db
    .update(schema.crcSessions)
    .set({
      status: "SIGNING",
      signedPsbtSha256,
      claimId: randomUUID(),
      claimedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schema.crcSessions.network, network),
        eq(schema.crcSessions.id, id),
        sql`${schema.crcSessions.expiresAt} > now()`,
        or(
          eq(schema.crcSessions.status, "BUILT"),
          and(
            eq(schema.crcSessions.status, "SIGNING"),
            sql`${schema.crcSessions.claimedAt} < now() - interval '30 seconds'`,
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

export async function markCrcBuildReady(
  db: Database,
  network: string,
  id: string,
  signedRawHex: string,
  txid: string,
  claimId: string,
) {
  if (!/^[0-9a-f]{64}$/.test(txid) || !/^(?:[0-9a-f]{2})+$/.test(signedRawHex))
    throw new Error("invalid signed CRC transaction");
  const [row] = await db
    .update(schema.crcSessions)
    .set({ status: "READY", signedRawHex, txid, updatedAt: new Date() })
    .where(
      and(
        eq(schema.crcSessions.network, network),
        eq(schema.crcSessions.id, id),
        eq(schema.crcSessions.status, "SIGNING"),
        eq(schema.crcSessions.claimId, claimId),
      ),
    )
    .returning();
  if (row) return row;
  const existing = await getCrcBuildSession(db, network, id);
  if (
    existing?.status === "READY" &&
    existing.signedRawHex === signedRawHex &&
    existing.txid === txid
  )
    return existing;
  throw new Error("CRC build session is not signing");
}

export async function markCrcBuildBroadcast(
  db: Database,
  network: string,
  id: string,
  txid: string,
) {
  const [row] = await db
    .update(schema.crcSessions)
    .set({ status: "BROADCAST", updatedAt: new Date() })
    .where(
      and(
        eq(schema.crcSessions.network, network),
        eq(schema.crcSessions.id, id),
        eq(schema.crcSessions.status, "READY"),
        eq(schema.crcSessions.txid, txid),
      ),
    )
    .returning();
  if (row) return row;
  const existing = await getCrcBuildSession(db, network, id);
  if (existing?.status === "BROADCAST" && existing.txid === txid) return existing;
  throw new Error("CRC build session is not ready to broadcast");
}

export async function releaseCrcBuildSession(
  db: Database,
  network: string,
  id: string,
  claimId: string,
) {
  await db
    .update(schema.crcSessions)
    .set({
      status: "BUILT",
      claimId: null,
      claimedAt: null,
      signedPsbtSha256: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schema.crcSessions.network, network),
        eq(schema.crcSessions.id, id),
        eq(schema.crcSessions.status, "SIGNING"),
        eq(schema.crcSessions.claimId, claimId),
      ),
    );
}
