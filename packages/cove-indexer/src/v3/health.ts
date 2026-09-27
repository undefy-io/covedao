import { eq } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";

/**
 * Indexer health gate (§5). The future Guardian/API must be able to require
 * HEALTHY before building/signing state transitions.
 */

export type IndexerHealth = "HEALTHY" | "BEHIND" | "REBUILDING" | "DIVERGED" | "CORE_UNREACHABLE";

export interface HealthReport {
  health: IndexerHealth;
  cursorHeight: bigint;
  cursorBlockHash: string;
  coreHeight: bigint;
  coreBlockHashAtCursor: string | null;
  lag: bigint;
  stateRoot: string;
  rebuilding: boolean;
}

export async function computeHealth(params: {
  db: Database;
  network: string;
  provider: CoreRpcProvider;
}): Promise<HealthReport> {
  const cursor = await params.db.select().from(schema.coveV3Cursor).where(eq(schema.coveV3Cursor.network, params.network));
  const c = cursor[0];
  if (!c) {
    return { health: "REBUILDING", cursorHeight: 0n, cursorBlockHash: "", coreHeight: 0n, coreBlockHashAtCursor: null, lag: 0n, stateRoot: "", rebuilding: true };
  }

  let coreHeight: bigint;
  let coreBlockHashAtCursor: string | null = null;
  try {
    const info = await params.provider.getBlockchainInfo();
    coreHeight = BigInt(info.blocks);
    if (c.height > 0n && c.height <= coreHeight) coreBlockHashAtCursor = await params.provider.getBlockHash(Number(c.height));
  } catch {
    return { health: "CORE_UNREACHABLE", cursorHeight: c.height, cursorBlockHash: c.blockHash, coreHeight: 0n, coreBlockHashAtCursor: null, lag: 0n, stateRoot: c.stateRoot, rebuilding: c.rebuilding };
  }

  const lag = coreHeight - c.height;
  let health: IndexerHealth;
  if (c.rebuilding) health = "REBUILDING";
  else if (c.height > coreHeight) health = "DIVERGED";
  else if (coreBlockHashAtCursor !== null && coreBlockHashAtCursor !== c.blockHash) health = "DIVERGED";
  else if (lag > 2n) health = "BEHIND";
  else health = "HEALTHY";

  return {
    health,
    cursorHeight: c.height,
    cursorBlockHash: c.blockHash,
    coreHeight,
    coreBlockHashAtCursor,
    lag,
    stateRoot: c.stateRoot,
    rebuilding: c.rebuilding,
  };
}
