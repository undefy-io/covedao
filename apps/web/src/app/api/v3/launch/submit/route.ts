import { rpcOperation } from "@/lib/api";
import { ok, handleError, readJson, strField } from "@/lib/api";
import { assertV3Enabled } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const limited = await checkRateLimit(req, "submit-launch");
    if (limited) return limited;
    const { app } = assertV3Enabled();
    const body = await readJson(req);
    const result = await rpcOperation(() => app.submitLaunch({
      sessionId: strField(body, "sessionId"),
      signedPsbtBase64: strField(body, "signedPsbtBase64"),
    }));
    return ok(result);
  } catch (e) {
    return handleError(e);
  }
}
