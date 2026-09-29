import { ok, handleError, readJson, strField } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { randomBytes } from "node:crypto";
import { reservationMessageToSign } from "@crclaunch/cove-market";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ listingId: string }> }) {
  try {
    const limited = await checkRateLimit(req, "reserve");
    if (limited) return limited;
    getV3Services();
    const { listingId } = await params;
    const body = await readJson(req);
    const buyerTokenScript = strField(body, "buyerTokenScript");
    const reserveNonce = randomBytes(32).toString("hex");
    const message = reservationMessageToSign({ version: 1, listingId, reserveNonce, buyerTokenScript });
    return ok({ reserveNonce, message });
  } catch (e) {
    return handleError(e);
  }
}
