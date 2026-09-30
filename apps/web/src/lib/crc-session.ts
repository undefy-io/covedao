import { and, eq, or, sql } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";

export type CrcBuildOperation = "deploy" | "mint-buy" | "inventory-buy" | "sell";

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
  const [row] = await db.select().from(schema.coveCrcBuildSessions)
    .where(and(eq(schema.coveCrcBuildSessions.network, network), eq(schema.coveCrcBuildSessions.id, id))).limit(1);
  return row ?? null;
}

export async function createCrcBuildSession(db: Database, input: NewCrcBuildSession) {
  if (!/^[0-9a-f]{64}$/.test(input.requestHash) || !/^[0-9a-f]{64}$/.test(input.unsignedTxDigest) ||
    input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128) {
    throw new Error("invalid CRC build session identity");
  }
  await db.insert(schema.coveCrcBuildSessions).values(input)
    .onConflictDoNothing({ target: [schema.coveCrcBuildSessions.network, schema.coveCrcBuildSessions.idempotencyKey] });
  const [row] = await db.select().from(schema.coveCrcBuildSessions)
    .where(and(eq(schema.coveCrcBuildSessions.network, input.network), eq(schema.coveCrcBuildSessions.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (!row || row.requestHash !== input.requestHash || row.operation !== input.operation ||
    row.walletScriptHex !== input.walletScriptHex || row.tokenScriptHex !== input.tokenScriptHex) {
    throw new Error("CRC build idempotency conflict");
  }
  return row;
}

export async function claimCrcBuildSession(db: Database, network: string, id: string, signedPsbtSha256: string) {
  if (!/^[0-9a-f]{64}$/.test(signedPsbtSha256)) throw new Error("invalid signed PSBT hash");
  const [row] = await db.update(schema.coveCrcBuildSessions)
    .set({ status: "SIGNING", signedPsbtSha256, claimedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(schema.coveCrcBuildSessions.network, network),
      eq(schema.coveCrcBuildSessions.id, id),
      sql`${schema.coveCrcBuildSessions.expiresAt} > now()`,
      or(
        eq(schema.coveCrcBuildSessions.status, "BUILT"),
        and(
          eq(schema.coveCrcBuildSessions.status, "SIGNING"),
          eq(schema.coveCrcBuildSessions.signedPsbtSha256, signedPsbtSha256),
          sql`${schema.coveCrcBuildSessions.claimedAt} < now() - interval '30 seconds'`,
        ),
      ),
    ))
    .returning();
  return row ?? null;
}

export async function markCrcBuildReady(db: Database, network: string, id: string, signedRawHex: string, txid: string) {
  if (!/^[0-9a-f]{64}$/.test(txid) || !/^(?:[0-9a-f]{2})+$/.test(signedRawHex)) throw new Error("invalid signed CRC transaction");
  const [row] = await db.update(schema.coveCrcBuildSessions)
    .set({ status: "READY", signedRawHex, txid, updatedAt: new Date() })
    .where(and(eq(schema.coveCrcBuildSessions.network, network), eq(schema.coveCrcBuildSessions.id, id), eq(schema.coveCrcBuildSessions.status, "SIGNING")))
    .returning();
  if (row) return row;
  const existing = await getCrcBuildSession(db, network, id);
  if (existing?.status === "READY" && existing.signedRawHex === signedRawHex && existing.txid === txid) return existing;
  throw new Error("CRC build session is not signing");
}

export async function markCrcBuildBroadcast(db: Database, network: string, id: string, txid: string) {
  const [row] = await db.update(schema.coveCrcBuildSessions)
    .set({ status: "BROADCAST", updatedAt: new Date() })
    .where(and(eq(schema.coveCrcBuildSessions.network, network), eq(schema.coveCrcBuildSessions.id, id), eq(schema.coveCrcBuildSessions.status, "READY"), eq(schema.coveCrcBuildSessions.txid, txid)))
    .returning();
  if (row) return row;
  const existing = await getCrcBuildSession(db, network, id);
  if (existing?.status === "BROADCAST" && existing.txid === txid) return existing;
  throw new Error("CRC build session is not ready to broadcast");
}
