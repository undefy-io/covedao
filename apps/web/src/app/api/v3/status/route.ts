import { ok, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const limited = checkRateLimit(req, "read-status");
    if (limited) return limited;
    return ok(await getV3Services().app.status());
  } catch (e) {
    return handleError(e);
  }
}
