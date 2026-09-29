import { ok, fail, handleError, noStore } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ fillId: string }> }) {
  try {
    const limited = await checkRateLimit(req, "read-fill");
    if (limited) return noStore(limited);
    const { app } = getV3Services();
    const { fillId } = await params;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(fillId)) return noStore(fail("BAD_REQUEST", "Invalid fill id", 400));
    return noStore(ok(await app.publicFillStatus(fillId.toLowerCase())));
  } catch (e) {
    return noStore(handleError(e));
  }
}
