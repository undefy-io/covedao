import { rpcOperation } from "@/lib/api";
import { ok, handleError, readJson, strField, bigintField } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** How many tokens a sats budget buys from the curve right now. */
export async function POST(req: Request) {
  try {
    const limited = await checkRateLimit(req, "quote-buy");
    if (limited) return limited;
    const { app } = getV3Services();
    const body = await readJson(req);
    return ok(await rpcOperation(() => app.quoteBuyForSats(strField(body, "tokenId"), bigintField(body, "budgetSats", 0n))));
  } catch (e) {
    return handleError(e);
  }
}
