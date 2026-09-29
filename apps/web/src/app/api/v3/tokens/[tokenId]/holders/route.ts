import { cachePublic } from "@/lib/public-read";
import { ok, fail, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  try {
    const limited = await checkRateLimit(req, "read-holders");
    if (limited) return limited;
    return await cachePublic(req, "confirmed", 5000, async () => {
      const query = new URL(req.url).searchParams;
      const rawLimit = query.get("limit") ?? "100";
      const rawOffset = query.get("offset") ?? "0";
      const limit = Number(rawLimit),
        offset = Number(rawOffset);
      if (
        !/^\d+$/.test(rawLimit) ||
        !/^\d+$/.test(rawOffset) ||
        !Number.isSafeInteger(limit) ||
        !Number.isSafeInteger(offset) ||
        limit < 1 ||
        limit > 200 ||
        offset > 10000
      ) {
        return fail("INVALID_PAGINATION", "Invalid limit or offset", 400);
      }
      const { app } = getV3Services();
      const { tokenId } = await params;
      return ok(await app.tokenHolders(tokenId, limit, offset));
    });
  } catch (e) {
    return handleError(e);
  }
}
