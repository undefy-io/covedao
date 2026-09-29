import { cachePublic } from "@/lib/public-read";
import { ok, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  try {
    const limited = await checkRateLimit(req, "read-token-activity");
    if (limited) return limited;
    return await cachePublic(req, "confirmed", 5000, async () => {
      const { app } = getV3Services();
      const { tokenId } = await params;
      return ok(await app.tokenActivity(tokenId, 100));
    });
  } catch (e) {
    return handleError(e);
  }
}
