import { AppError, readFeeObservation } from "@crclaunch/cove-app";
import type { Database } from "@crclaunch/db";
import type { FeeTierKey } from "@crclaunch/bitcoin";
import { findCrcBuildSessionByKey } from "./crc-session";
/** A repeated user request keeps its already selected rate and immutable plan. */
export async function readCrcBuildFeeRate(
  db: Database,
  network: string,
  key: string,
  tier: FeeTierKey,
): Promise<number> {
  const existing = await findCrcBuildSessionByKey(db, network, key);
  if (existing) {
    const rate = (existing.trustedJson as Record<string, unknown>).feeRateSatPerVb;
    if (typeof rate !== "number" || !Number.isSafeInteger(rate) || rate < 1 || rate > 500)
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        "CRC idempotency key belongs to a different fee method",
      );
    return rate;
  }
  const rates = await readFeeObservation(db, network);
  const rate = rates.tiers.find((candidate) => candidate.key === tier)?.satPerVb;
  if (!rate || rate < rates.floorSatPerVb || rate > rates.ceilingSatPerVb)
    throw new AppError("MINER_FEE_TOO_HIGH", "Mining speed is unavailable");
  return Number(rate);
}
