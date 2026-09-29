import { ok, fail, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";
import { bucketTrades, summarize, BUCKET_MS, type Interval } from "@/lib/ohlc";
import { and, desc, eq, isNotNull, inArray } from "drizzle-orm";
import { schema } from "@crclaunch/db";

export const dynamic = "force-dynamic";

const INTERVALS = Object.keys(BUCKET_MS) as Interval[];
/** Enough candles to fill the chart without letting a caller pull the whole table. */
const MAX_TRADES = 5_000;

/**
 * OHLC price history for one token.
 *
 * Two sources, one series: settled peer-to-peer fills, and buys or sells
 * against the backing vault. The vault trades matter most — a token that has
 * only ever minted has no peer-to-peer fills at all, and used to render an
 * empty chart.
 *
 * Only canonical records count: anything on a block that was later reorganised
 * out has `canonical = false` and must not appear in a price series.
 *
 * The time axis is `createdAt` — when the indexer observed the trade — because
 * block timestamps are not currently stored. At one block every ten minutes the
 * two are close, but they are not the same thing, and the response says so in
 * `timeBasis` rather than letting a caller assume block time.
 */
export async function GET(req: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  try {
    const limited = await checkRateLimit(req, "read-candles");
    if (limited) return limited;

    const { tokenId } = await params;
    const url = new URL(req.url);
    const raw = url.searchParams.get("interval") ?? "1h";
    if (!INTERVALS.includes(raw as Interval)) {
      return fail("BAD_INTERVAL", `interval must be one of ${INTERVALS.join(", ")}`, 400);
    }
    const interval = raw as Interval;

    const { db, config } = getV3Services();
    const rows = await db
      .select({
        amountAtoms: schema.coveV3MarketTrades.amountAtoms,
        totalPriceSats: schema.coveV3MarketTrades.totalPriceSats,
        createdAt: schema.coveV3MarketTrades.createdAt,
      })
      .from(schema.coveV3MarketTrades)
      .where(
        and(
          eq(schema.coveV3MarketTrades.network, config.network),
          eq(schema.coveV3MarketTrades.tokenId, tokenId),
          eq(schema.coveV3MarketTrades.canonical, true),
        ),
      )
      .orderBy(desc(schema.coveV3MarketTrades.blockHeight))
      .limit(MAX_TRADES)
      // The newest MAX_TRADES, returned oldest first: capping an ascending
      // scan instead dropped the latest trades once history grew.
      .then((r) => r.reverse());

    // Curve trades: a valid MINT or REDEEM carries the amount and the satoshis
    // that moved to or from the reserve, which is exactly a price.
    const curveRows = await db
      .select({
        amountAtoms: schema.coveV3Events.amountAtoms,
        grossSats: schema.coveV3Events.grossSats,
        operation: schema.coveV3Events.operation,
        createdAt: schema.coveV3Events.createdAt,
      })
      .from(schema.coveV3Events)
      .where(
        and(
          eq(schema.coveV3Events.network, config.network),
          eq(schema.coveV3Events.tokenId, tokenId),
          eq(schema.coveV3Events.canonical, true),
          eq(schema.coveV3Events.valid, true),
          inArray(schema.coveV3Events.operation, ["MINT", "REDEEM"]),
          isNotNull(schema.coveV3Events.grossSats),
        ),
      )
      .orderBy(desc(schema.coveV3Events.blockHeight))
      .limit(MAX_TRADES)
      // The newest MAX_TRADES, returned oldest first: capping an ascending
      // scan instead dropped the latest trades once history grew.
      .then((r) => r.reverse());

    const market = rows.map((r) => ({
      timestamp: r.createdAt.getTime(),
      amountAtoms: r.amountAtoms,
      totalPriceSats: r.totalPriceSats,
    }));
    const curve = curveRows.map((r) => ({
      timestamp: r.createdAt.getTime(),
      amountAtoms: r.amountAtoms!,
      totalPriceSats: r.grossSats!,
    }));

    const candles = bucketTrades([...market, ...curve], interval);

    return ok({
      tokenId,
      interval,
      /** Price unit for every OHLC value below. */
      unit: "sats-per-1m-tokens",
      timeBasis: "indexer-observed",
      /** How many of each kind went into the series above. */
      sources: { market: market.length, curve: curve.length },
      truncated: rows.length >= MAX_TRADES || curveRows.length >= MAX_TRADES,
      candles,
      summary: summarize(candles),
    });
  } catch (e) {
    return handleError(e);
  }
}
