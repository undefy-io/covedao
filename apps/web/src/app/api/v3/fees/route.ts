import { estimateOperationVsize, readFeeObservation } from "@crclaunch/cove-app";
import { ok, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Live Bitcoin fee rates, read from the node this deployment is using.
 *
 * The client picks a RATE, never a fee amount: only the server knows how many
 * vbytes the transaction it is about to build will take, and a fee that does
 * not match the size is the difference between confirming and sitting in the
 * mempool until it is evicted.
 */
export async function GET(req: Request) {
  try {
    const limited = checkRateLimit(req, "read-fees");
    if (limited) return limited;
    const { db, config } = getV3Services();
    const rates = await readFeeObservation(db, config.network);
    // A typical transaction of each kind: one funding input, a P2WPKH wallet.
    // The browser multiplies these by the chosen rate to PREVIEW a fee; the
    // server still sizes the real one against the transaction it builds.
    const shape = { fundingInputs: 1, walletScriptBytes: 22, feeScriptBytes: 22 };
    const typicalVsize = {
      DEPLOY: estimateOperationVsize("DEPLOY", shape),
      BACKING_BUY: estimateOperationVsize("BACKING_BUY", shape),
      REDEEM: estimateOperationVsize("REDEEM", { ...shape, tokenInputs: 1 }),
      TRANSFER: estimateOperationVsize("TRANSFER", { ...shape, tokenInputs: 1, recipientCarriers: 2 }),
    };
    return ok({
      typicalVsize,
      floorSatPerVb: rates.floorSatPerVb,
      ceilingSatPerVb: rates.ceilingSatPerVb,
      estimated: rates.estimated,
      tiers: rates.tiers,
    });
  } catch (e) {
    return handleError(e);
  }
}
