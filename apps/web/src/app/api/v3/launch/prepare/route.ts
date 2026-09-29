import { ok, handleError, readJson, strField } from "@/lib/api";
import { assertV3Enabled } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const limited = await checkRateLimit(req, "prepare-launch");
    if (limited) return limited;
    const { app } = assertV3Enabled();
    const body = await readJson(req);
    const result = app.prepareLaunch({
      ticker: strField(body, "ticker"),
      displayName: strField(body, "displayName"),
      description: strField(body, "description"),
      websiteUrl: strField(body, "websiteUrl") || null,
      xUrl: strField(body, "xUrl") || null,
      imageUrl: strField(body, "imageUrl") || null,
      nonceHex: strField(body, "nonceHex") || undefined,
    });
    return ok(result);
  } catch (e) {
    return handleError(e);
  }
}
