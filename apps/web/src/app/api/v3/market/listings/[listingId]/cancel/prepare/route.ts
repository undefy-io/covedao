import { randomBytes } from "node:crypto";
import { ok, handleError, readJson, strField } from "@/lib/api";
import { assertV3Enabled } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ listingId: string }> }) {
  try {
    const limited = await checkRateLimit(req, "prepare-cancel");
    if (limited) return limited;
    const { app } = assertV3Enabled();
    const { listingId } = await params;
    const body = await readJson(req);
    const nonceHex = strField(body, "nonceHex") || randomBytes(32).toString("hex");
    return ok(app.prepareCancellation(listingId, nonceHex));
  } catch (e) {
    return handleError(e);
  }
}
