import { ok, handleError, readJson, strField } from "@/lib/api";
import { assertV3Enabled } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ fillId: string }> }) {
  try {
    const limited = checkRateLimit(req, "buyer-sign");
    if (limited) return limited;
    const { app } = assertV3Enabled();
    const { fillId } = await params;
    const body = await readJson(req);
    // The buyer's signature completes the sale: the server attaches the
    // seller's presignature and broadcasts. No seller step.
    const { txid } = await app.submitBuyerSignature(fillId, strField(body, "signedPsbtBase64"));
    return ok({ fillId, status: "BROADCAST", txid });
  } catch (e) {
    return handleError(e);
  }
}
