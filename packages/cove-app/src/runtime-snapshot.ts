import { schema, type Database } from "@crclaunch/db";
import type { BlockchainInfo, FeeRates } from "@crclaunch/bitcoin";
import { eq } from "drizzle-orm";
import { AppError } from "./errors.js";

export async function saveChainObservation(db: Database, network: string, info: BlockchainInfo | null): Promise<void> {
  const fields = {
    coreReachable: info !== null,
    chainObservedAt: new Date(),
    ...(info ? { coreHeight: BigInt(info.blocks), coreTip: info.bestBlockHash } : {}),
  };
  await db.insert(schema.coveV3Runtime).values({ network, ...fields })
    .onConflictDoUpdate({ target: schema.coveV3Runtime.network, set: fields });
}

export async function saveFeeObservation(db: Database, network: string, rates: FeeRates): Promise<void> {
  const fields = {
    feesObservedAt: new Date(),
    feeRates: {
      ...rates, floorSatPerVb: rates.floorSatPerVb.toString(), ceilingSatPerVb: rates.ceilingSatPerVb.toString(),
      tiers: rates.tiers.map((tier) => ({ ...tier, satPerVb: tier.satPerVb.toString() })),
    },
  };
  await db.insert(schema.coveV3Runtime).values({ network, ...fields })
    .onConflictDoUpdate({ target: schema.coveV3Runtime.network, set: fields });
}

export async function readFeeObservation(db: Database, network: string): Promise<FeeRates> {
  const [snapshot] = await db.select().from(schema.coveV3Runtime).where(eq(schema.coveV3Runtime.network, network));
  if (!snapshot?.feeRates || !snapshot.feesObservedAt || Date.now() - snapshot.feesObservedAt.getTime() > 120_000) {
    throw new AppError("CORE_UNAVAILABLE", "the worker's fee observation is missing or stale");
  }
  return {
    ...snapshot.feeRates,
    floorSatPerVb: BigInt(snapshot.feeRates.floorSatPerVb),
    ceilingSatPerVb: BigInt(snapshot.feeRates.ceilingSatPerVb),
    tiers: snapshot.feeRates.tiers.map((tier) => ({ ...tier, satPerVb: BigInt(tier.satPerVb) })),
  };
}
