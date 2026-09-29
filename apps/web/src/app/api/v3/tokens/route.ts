import { cachePublic } from "@/lib/public-read";
import { ok, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const limited = await checkRateLimit(req, "read-tokens");
    if (limited) return limited;
    return await cachePublic(req, "market", 2000, async () => {
      const { app } = getV3Services();
      const url = new URL(req.url);
      const search = url.searchParams.get("search") ?? url.searchParams.get("ticker") ?? undefined;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      return ok(await app.listTokens({ search, limit }));
    });
  } catch (e) {
    return handleError(e);
  }
}
