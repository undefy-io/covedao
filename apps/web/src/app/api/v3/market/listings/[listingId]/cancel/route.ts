import { rpcOperation } from "@/lib/api";
import { ok, handleError, readJson, strField } from "@/lib/api";
import { assertV3Enabled } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ listingId: string }> }) {
  try {
    const limited = await checkRateLimit(req, "cancel-listing");
    if (limited) return limited;
    const { app } = assertV3Enabled();
    const { listingId } = await params;
    const body = await readJson(req);
    await rpcOperation(() => app.cancelListing(listingId, strField(body, "nonceHex"), strField(body, "signatureB64")));
    return ok({ listingId, status: "CANCELLED" });
  } catch (e) {
    return handleError(e);
  }
}
