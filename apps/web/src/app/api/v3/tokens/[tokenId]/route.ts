import { ok, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";
import { AppError } from "@crclaunch/cove-app";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  try {
    const limited = await checkRateLimit(req, "read-token");
    if (limited) return limited;
    const { app } = getV3Services();
    const { tokenId } = await params;
    const detail = await app.tokenDetail(tokenId);
    if (!detail) throw new AppError("TOKEN_NOT_FOUND", "token not found");
    return ok(detail);
  } catch (e) {
    return handleError(e);
  }
}
