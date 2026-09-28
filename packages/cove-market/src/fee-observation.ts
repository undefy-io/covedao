import { schema, type Database } from "@crclaunch/db";
import type { FeeRates } from "@crclaunch/bitcoin";
import { eq } from "drizzle-orm";
import { MarketError } from "./errors.js";

const MAX_FEE_AGE_MS = 120_000;

export async function readStoredFeeObservation(db: Database, network: string): Promise<FeeRates> {
  const [snapshot] = await db.select().from(schema.coveV3Runtime).where(eq(schema.coveV3Runtime.network, network));
  const observedAt = snapshot?.feesObservedAt?.getTime();
  if (!snapshot?.feeRates || observedAt === undefined || !Number.isFinite(observedAt) ||
      observedAt > Date.now() || Date.now() - observedAt > MAX_FEE_AGE_MS) {
    throw new MarketError("CORE_UNAVAILABLE", "the worker's fee observation is missing or stale");
  }
  return {
    ...snapshot.feeRates,
    floorSatPerVb: BigInt(snapshot.feeRates.floorSatPerVb),
    ceilingSatPerVb: BigInt(snapshot.feeRates.ceilingSatPerVb),
    tiers: snapshot.feeRates.tiers.map((tier) => ({ ...tier, satPerVb: BigInt(tier.satPerVb) })),
  };
}
