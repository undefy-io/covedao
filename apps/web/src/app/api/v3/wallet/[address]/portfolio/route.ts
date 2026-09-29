import { ok, fail, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { addressToScript } from "@/lib/address";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const limited = await checkRateLimit(req, "read-portfolio");
    if (limited) return limited;
    const query = new URL(req.url).searchParams;
    const rawLimit = query.get("limit") ?? "100";
    const rawOffset = query.get("offset") ?? "0";
    const limit = Number(rawLimit), offset = Number(rawOffset);
    if (!/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(limit) || !Number.isSafeInteger(offset) || limit < 1 || limit > 500 || offset > 10000) {
      return fail("INVALID_PAGINATION", "Invalid limit or offset", 400);
    }
    const { app, config } = getV3Services();
    const { address } = await params;
    const script = addressToScript(address, config.network);
    return ok(await app.walletPortfolio(script, { limit, offset }));
  } catch (e) {
    return handleError(e);
  }
}
