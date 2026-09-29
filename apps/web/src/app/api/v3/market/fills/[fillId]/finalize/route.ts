import { rpcOperation } from "@/lib/api";
import { ok, handleError } from "@/lib/api";
import { assertV3Enabled } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ fillId: string }> }) {
  try {
    const limited = await checkRateLimit(_req, "finalize-fill");
    if (limited) return limited;
    const { app } = assertV3Enabled();
    const { fillId } = await params;
    const result = await rpcOperation(() => app.finalizeAndBroadcastFill(fillId));
    return ok({ fillId, ...result });
  } catch (e) {
    return handleError(e);
  }
}
