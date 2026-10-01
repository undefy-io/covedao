import { readFeeObservation } from "@crclaunch/cove-app";
import { fail, handleError, ok } from "@/lib/api";
import { checkCrcRateLimit } from "@/lib/crc-rate-limit";
import { getCrcReadServices } from "@/lib/crc-server";
import { PublicReadCache } from "@/lib/read-cache";

export const dynamic = "force-dynamic";
const cache = new PublicReadCache(8, 64 * 1024, 8);

export async function GET(req: Request) {
  try {
    const limited = checkCrcRateLimit(req);
    if (limited) return limited;
    const { db, network } = getCrcReadServices();
    return await cache.read(`${network}:crc-fees`, async () => "fees", 5_000, async () => {
      const rates = await readFeeObservation(db, network);
      const tiers = rates.tiers.filter((tier) => tier.satPerVb * 380n <= 20_000n);
      if (!tiers.length) return fail("MINER_FEE_TOO_HIGH", "Current fees exceed the 20,000-sat limit", 503, true);
      return ok({
        floorSatPerVb: rates.floorSatPerVb,
        ceilingSatPerVb: rates.ceilingSatPerVb,
        estimated: rates.estimated,
        tiers,
        maxMinerFeeSats: "20000",
        typicalVsize: { DEPLOY: 380, BACKING_BUY: 380, REDEEM: 380, TRANSFER: 380 },
      });
    });
  } catch (error) {
    return handleError(error);
  }
}
