import { ok, fail, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";
import { loadSparklines } from "@/lib/sparklines-db";

export const dynamic = "force-dynamic";

/** A list page shows tens of tokens; one request must cover all of them. */
const MAX_TOKENS = 100;

/**
 * Recent price series for many tokens at once.
 *
 * Explore and Market render a sparkline per row. Asking for them one at a time
 * would mean tens of round trips per page load, so this takes the whole set of
 * token ids and answers with one query.
 *
 * Each series is the closing price of the last 32 hourly buckets, in sats
 * per 1,000,000 tokens — the same unit, the same bucketing AND the same two
 * sources the full chart uses (peer-to-peer fills plus curve trades), so a row
 * and its token page never disagree.
 *
 * Tokens that have never traded are returned with an empty array rather than
 * omitted, so the caller can tell "no trades" from "not asked for".
 */
export async function GET(req: Request) {
  try {
    const limited = checkRateLimit(req, "read-sparklines");
    if (limited) return limited;

    const url = new URL(req.url);
    const ids = (url.searchParams.get("tokenIds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) return ok({ series: {} });
    if (ids.length > MAX_TOKENS) {
      return fail("TOO_MANY_TOKENS", `at most ${MAX_TOKENS} token ids per request`, 400);
    }

    const { db, config } = getV3Services();
    const { series, lastPrice } = await loadSparklines(db, config.network, [...new Set(ids)]);

    return ok({ unit: "sats-per-1m-tokens", interval: "1h", series, lastPrice });
  } catch (e) {
    return handleError(e);
  }
}
