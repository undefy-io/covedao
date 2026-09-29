import { schema, type Database, type DbTransaction } from "@crclaunch/db";
import {
  loadFeeRates,
  type BlockchainInfo,
  type FeeRates,
  type CoreRpcProvider,
} from "@crclaunch/bitcoin";
import { readStoredFeeObservation } from "@crclaunch/cove-market";
import { AppError } from "./errors.js";

export async function saveChainObservation(
  db: Database | DbTransaction,
  network: string,
  info: BlockchainInfo | null,
): Promise<void> {
  const fields = {
    coreReachable: info !== null,
    chainObservedAt: new Date(),
    ...(info ? { coreHeight: BigInt(info.blocks), coreTip: info.bestBlockHash } : {}),
  };
  await db
    .insert(schema.coveV3Runtime)
    .values({ network, ...fields })
    .onConflictDoUpdate({ target: schema.coveV3Runtime.network, set: fields });
}

export async function saveFeeObservation(
  db: Database | DbTransaction,
  network: string,
  rates: FeeRates,
  observedAt: Date,
): Promise<void> {
  const fields = {
    feesObservedAt: observedAt,
    feeRates: {
      ...rates,
      floorSatPerVb: rates.floorSatPerVb.toString(),
      ceilingSatPerVb: rates.ceilingSatPerVb.toString(),
      tiers: rates.tiers.map((tier) => ({ ...tier, satPerVb: tier.satPerVb.toString() })),
    },
  };
  await db
    .insert(schema.coveV3Runtime)
    .values({ network, ...fields })
    .onConflictDoUpdate({ target: schema.coveV3Runtime.network, set: fields });
}

export async function collectFeeObservation(
  provider: CoreRpcProvider,
): Promise<{ rates: FeeRates; observedAt: Date }> {
  const startedAt = new Date();
  const rates = await loadFeeRates(provider, { signal: AbortSignal.timeout(20_000), retry: true });
  return { rates, observedAt: startedAt };
}

export async function readFeeObservation(db: Database, network: string): Promise<FeeRates> {
  try {
    return await readStoredFeeObservation(db, network);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "CORE_UNAVAILABLE") {
      throw new AppError("CORE_UNAVAILABLE", error.message);
    }
    throw error;
  }
}
