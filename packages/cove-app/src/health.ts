import { schema, type Database } from "@crclaunch/db";
import { eq } from "drizzle-orm";
import type { V3AppConfig } from "./config.js";

/**
 * V3 operational health (§63). Returns no secrets — only heights, hashes,
 * health states, and capability flags.
 */

export interface V3Status {
  network: string;
  appEnabled: boolean;
  core: {
    reachable: boolean;
    height: bigint;
    tip: string;
    observedAt: string | null;
    stale: boolean;
  };
  indexer: {
    health: string;
    indexedHeight: bigint;
    indexedBlockHash: string;
    stateRoot: string;
    lag: bigint;
    rebuilding: boolean;
  };
  guardian: {
    configured: boolean;
  };
  market: {
    enabled: boolean;
  };
}

export async function getV3Status(params: {
  db: Database;
  config: V3AppConfig;
}): Promise<V3Status> {
  const { db, config } = params;
  const [runtimeRows, cursorRows, marketFlag] = await Promise.all([
    db.select().from(schema.coveV3Runtime).where(eq(schema.coveV3Runtime.network, config.network)),
    db.select().from(schema.coveV3Cursor).where(eq(schema.coveV3Cursor.network, config.network)),
    db.select().from(schema.featureFlags).where(eq(schema.featureFlags.id, "cove-v3-market")),
  ]);
  const runtime = runtimeRows[0];
  const cursor = cursorRows[0];
  const stale = !runtime?.chainObservedAt || Date.now() - runtime.chainObservedAt.getTime() > Math.max(30_000, config.settings.workerPollMs * 3);
  const coreReachable = !stale && runtime?.coreReachable === true;
  const coreHeight = runtime?.coreHeight ?? 0n;
  const indexedHeight = cursor?.height ?? 0n;
  const lag = coreHeight > indexedHeight ? coreHeight - indexedHeight : 0n;
  const rebuilding = cursor?.rebuilding ?? true;
  const health = stale ? "STALE" : !coreReachable ? "CORE_UNREACHABLE"
    : rebuilding ? "REBUILDING"
      : indexedHeight > coreHeight || (indexedHeight === coreHeight && cursor?.blockHash !== runtime?.coreTip) ? "DIVERGED"
        : lag > 2n ? "BEHIND" : "HEALTHY";

  return {
    network: config.network,
    appEnabled: config.enabled,
    core: { reachable: coreReachable, height: coreHeight, tip: runtime?.coreTip ?? "", observedAt: runtime?.chainObservedAt?.toISOString() ?? null, stale },
    indexer: {
      health,
      indexedHeight,
      indexedBlockHash: cursor?.blockHash ?? "",
      stateRoot: cursor?.stateRoot ?? "",
      lag,
      rebuilding,
    },
    guardian: { configured: config.guardianPrivateKey !== null },
    market: { enabled: marketFlag[0]?.enabled ?? true },
  };
}
