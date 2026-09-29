import { databaseDate, type Database } from "@crclaunch/db";
import { sql } from "drizzle-orm";
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
  observations: {
    chainGeneration: string;
    tradeRevision: string;
    marketWindow: string;
    pendingRevision: string;
    marketRevision: string;
    metadataRevision: string;
    pendingObservedAt: string | null;
    feesObservedAt: string | null;
  };
}

export async function getV3Status(params: {
  db: Database;
  config: V3AppConfig;
}): Promise<V3Status> {
  const { db, config } = params;
  const result =
    await db.execute(sql`select r.core_height::text, r.core_tip, r.core_reachable, r.chain_observed_at, r.pending_observed_at, r.fees_observed_at,
    c.height::text as indexed_height, c.block_hash, c.state_root, c.rebuilding,
    e.chain_generation::text, e.trade_revision::text, e.pending_revision::text, e.market_revision::text, e.metadata_revision::text,
    (select enabled from feature_flags where id = 'cove-v3-market') as market_enabled
    from (select ${config.network}::text as network) n left join cove_v3_runtime r on r.network = n.network
    left join cove_v3_cursor c on c.network = n.network left join cove_observation_epochs e on e.network = n.network`);
  const row = result.rows[0];
  const runtime = row
    ? {
        coreHeight: BigInt(String(row.core_height ?? "0")),
        coreTip: String(row.core_tip ?? ""),
        coreReachable: row.core_reachable === true,
        chainObservedAt: databaseDate(row.chain_observed_at),
      }
    : undefined;
  const cursor =
    row?.indexed_height != null
      ? {
          height: BigInt(String(row.indexed_height)),
          blockHash: String(row.block_hash ?? ""),
          stateRoot: String(row.state_root ?? ""),
          rebuilding: row.rebuilding === true,
        }
      : undefined;
  const stale =
    !runtime?.chainObservedAt ||
    Date.now() - runtime.chainObservedAt.getTime() >
      Math.max(30_000, config.settings.workerPollMs * 3);
  const coreReachable = !stale && runtime?.coreReachable === true;
  const coreHeight = runtime?.coreHeight ?? 0n;
  const indexedHeight = cursor?.height ?? 0n;
  const lag = coreHeight > indexedHeight ? coreHeight - indexedHeight : 0n;
  const rebuilding = cursor?.rebuilding ?? true;
  const health = stale
    ? "STALE"
    : !coreReachable
      ? "CORE_UNREACHABLE"
      : rebuilding
        ? "REBUILDING"
        : indexedHeight > coreHeight ||
            (indexedHeight === coreHeight && cursor?.blockHash !== runtime?.coreTip)
          ? "DIVERGED"
          : lag > 2n
            ? "BEHIND"
            : "HEALTHY";

  return {
    network: config.network,
    appEnabled: config.enabled,
    core: {
      reachable: coreReachable,
      height: coreHeight,
      tip: runtime?.coreTip ?? "",
      observedAt: runtime?.chainObservedAt?.toISOString() ?? null,
      stale,
    },
    indexer: {
      health,
      indexedHeight,
      indexedBlockHash: cursor?.blockHash ?? "",
      stateRoot: cursor?.stateRoot ?? "",
      lag,
      rebuilding,
    },
    guardian: {
      configured:
        config.guardianPrivateKey !== null ||
        Boolean(config.guardianEndpoint && config.guardianAuthToken),
    },
    market: { enabled: row?.market_enabled == null ? true : row.market_enabled === true },
    observations: {
      marketWindow: String(Math.floor(Date.now() / 60000)),
      tradeRevision: String(row?.trade_revision ?? "0"),
      chainGeneration: String(row?.chain_generation ?? "0"),
      pendingRevision: String(row?.pending_revision ?? "0"),
      marketRevision: String(row?.market_revision ?? "0"),
      metadataRevision: String(row?.metadata_revision ?? "0"),
      pendingObservedAt: databaseDate(row?.pending_observed_at)?.toISOString() ?? null,
      feesObservedAt: databaseDate(row?.fees_observed_at)?.toISOString() ?? null,
    },
  };
}
