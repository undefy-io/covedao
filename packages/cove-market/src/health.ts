import { eq } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { computeHealth, type HealthReport } from "@crclaunch/cove-indexer/v3";
import { MarketError } from "./errors.js";
import type { MarketConfig } from "./config.js";

/**
 * Market health gate + kill switch (§29). A listing may only be created when
 * the indexer is HEALTHY and the market is not disabled. Every other critical
 * step (reserve/PSBT-build/seller-sign/broadcast) re-checks health too.
 */

export function assertMarketEnabled(config: MarketConfig): void {
  if (!config.enabled) throw new MarketError("MARKET_DISABLED", "market is disabled");
}

export function healthErrorFor(report: HealthReport): MarketError | null {
  switch (report.health) {
    case "HEALTHY":
      return null;
    case "CORE_UNREACHABLE":
      return new MarketError("INDEXER_UNHEALTHY", "Bitcoin Core unreachable");
    case "REBUILDING":
      return new MarketError("INDEXER_REBUILDING", "indexer is rebuilding");
    case "BEHIND":
      return new MarketError("INDEXER_BEHIND", `indexer behind by ${report.lag} blocks`);
    case "DIVERGED":
      return new MarketError("INDEXER_DIVERGED", "indexer cursor diverged from Core tip");
    default:
      return new MarketError("INDEXER_UNHEALTHY", report.health);
  }
}

/** Throw unless the indexer is HEALTHY (and the market enabled). */
export async function assertMarketReady(params: {
  db: Database;
  config: MarketConfig;
  provider: CoreRpcProvider;
  observation?: HealthReport;
}): Promise<HealthReport> {
  assertMarketEnabled(params.config);
  const report = await computeHealth({
    db: params.db,
    network: params.config.network,
    provider: params.provider,
    observation: params.observation,
  });
  const err = healthErrorFor(report);
  if (err) throw err;
  return report;
}

/** Read the persisted disable switch (a row in feature_flags). */
export async function marketEnabledFlag(db: Database): Promise<boolean> {
  const rows = await db.select().from(schema.featureFlags).where(eq(schema.featureFlags.id, "cove-v3-market"));
  return rows[0]?.enabled ?? true;
}
