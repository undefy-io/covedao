import { cachePublic } from "@/lib/public-read";
import { ok, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const limited = await checkRateLimit(req, "read-status");
    if (limited) return limited;
    return await cachePublic(req, "status", 1_000, async () => {
      return ok(await getV3Services().app.status());
    });
  } catch (e) {
    return handleError(e);
  }
}
