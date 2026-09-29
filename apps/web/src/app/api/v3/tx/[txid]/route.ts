import { ok, fail, handleError, noStore } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ txid: string }> }) {
  try {
    const limited = await checkRateLimit(req, "read-tx");
    if (limited) return noStore(limited);
    const { app } = getV3Services();
    const { txid } = await params;
    if (!/^[a-f0-9]{64}$/i.test(txid)) return noStore(fail("BAD_REQUEST", "Invalid transaction id", 400));
    return noStore(ok(await app.txStatus(txid.toLowerCase())));
  } catch (e) {
    return noStore(handleError(e));
  }
}
