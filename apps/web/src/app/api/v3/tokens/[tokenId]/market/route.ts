import { ok, handleError } from "@/lib/api";
import { getV3Services } from "@/lib/v3-server";
import { checkRateLimit } from "@/lib/rate-limit";
import { unitPriceSats } from "@/lib/ohlc";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@crclaunch/db";

export const dynamic = "force-dynamic";

/** Settled sales returned in the feed. Matches what fits on one screen. */
const RECENT_LIMIT = 240;
/** Ceiling on the rows scanned for the aggregates. */
const SCAN_LIMIT = 5_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything the market header and the sales feed need, in one request.
 *
 * All of it is derived from settled peer-to-peer fills — the same rows the
 * candles come from — so the header can never disagree with the chart.
 *
 * Prices are sats, not dollars. Quoting USD would mean trusting an exchange
 * rate feed, and nothing else in this product depends on one; a caller that
 * wants dollars can apply its own rate to these numbers.
 */
export async function GET(req: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  try {
    const limited = await checkRateLimit(req, "read-market-stats");
    if (limited) return limited;

    const { tokenId } = await params;
    const { db, config } = getV3Services();

    const where = and(
      eq(schema.coveV3MarketTrades.network, config.network),
      eq(schema.coveV3MarketTrades.tokenId, tokenId),
      eq(schema.coveV3MarketTrades.canonical, true),
    );

    const rows = await db
      .select({
        txid: schema.coveV3MarketTrades.txid,
        amountAtoms: schema.coveV3MarketTrades.amountAtoms,
        totalPriceSats: schema.coveV3MarketTrades.totalPriceSats,
        buyer: schema.coveV3MarketTrades.buyerTokenScript,
        seller: schema.coveV3MarketTrades.sellerTokenScript,
        blockHeight: schema.coveV3MarketTrades.blockHeight,
        createdAt: schema.coveV3MarketTrades.createdAt,
      })
      .from(schema.coveV3MarketTrades)
      .where(where)
      .orderBy(desc(schema.coveV3MarketTrades.blockHeight))
      .limit(SCAN_LIMIT)
      // The newest SCAN_LIMIT, returned oldest first: capping an ascending
      // scan instead dropped the latest trades once history grew.
      .then((r) => r.reverse());

    // Open asks, cheapest first — the "floor" is the best one a buyer can take.
    const listings = await db
      .select({
        listingId: schema.coveV3MarketListings.listingId,
        amountAtoms: schema.coveV3MarketListings.amountAtoms,
        totalPriceSats: schema.coveV3MarketListings.totalPriceSats,
        status: schema.coveV3MarketListings.status,
        sellerTokenScript: schema.coveV3MarketListings.sellerTokenScript,
        expiryHeight: schema.coveV3MarketListings.expiryHeight,
      })
      .from(schema.coveV3MarketListings)
      .where(
        and(
          eq(schema.coveV3MarketListings.network, config.network),
          eq(schema.coveV3MarketListings.tokenId, tokenId),
          eq(schema.coveV3MarketListings.status, "ACTIVE"),
        ),
      )
      .orderBy(desc(schema.coveV3MarketListings.creationHeight))
      .limit(200);

    const asks = listings
      .map((l) => ({
        listingId: l.listingId,
        unitPriceSats: unitPriceSats(l.amountAtoms, l.totalPriceSats),
        amountTokens: Number(BigInt(l.amountAtoms) / 100_000_000n),
        totalPriceSats: l.totalPriceSats.toString(),
        status: l.status,
        sellerTokenScript: l.sellerTokenScript,
      }))
      .sort((a, b) => a.unitPriceSats - b.unitPriceSats);

    const sales = rows.map((r) => ({
      txid: r.txid,
      blockHeight: r.blockHeight.toString(),
      at: r.createdAt.toISOString(),
      amountTokens: Number(BigInt(r.amountAtoms) / 100_000_000n),
      unitPriceSats: unitPriceSats(r.amountAtoms, r.totalPriceSats),
      totalPriceSats: r.totalPriceSats.toString(),
      buyer: r.buyer,
      seller: r.seller,
    }));

    const now = Date.now();
    const since = (ms: number) => rows.filter((r) => now - r.createdAt.getTime() <= ms);
    const sumSats = (rs: typeof rows) => rs.reduce((a, r) => a + BigInt(r.totalPriceSats), 0n);

    const day = since(DAY_MS);
    const week = since(7 * DAY_MS);
    const prevWeek = rows.filter((r) => {
      const age = now - r.createdAt.getTime();
      return age > 7 * DAY_MS && age <= 14 * DAY_MS;
    });

    const last = sales[sales.length - 1] ?? null;
    const dayFirst = day[0];
    const lastPrice = last?.unitPriceSats ?? null;
    const dayOpen = dayFirst ? unitPriceSats(dayFirst.amountAtoms, dayFirst.totalPriceSats) : null;

    const weekSats = sumSats(week);
    const prevWeekSats = sumSats(prevWeek);
    const pct = (a: bigint, b: bigint) => (b === 0n ? null : (Number(a - b) / Number(b)) * 100);

    // Market cap uses the last settled price against the FULL supply, which is
    // what "market cap" means everywhere — not the circulating amount.
    const TOTAL_SUPPLY_TOKENS = 1_000_000_000;
    const marketCapSats =
      lastPrice === null ? null : Math.round((lastPrice * TOTAL_SUPPLY_TOKENS) / 1_000_000);

    return ok({
      tokenId,
      unit: "sats-per-1m-tokens",
      floorSats: asks[0]?.unitPriceSats ?? null,
      lastPriceSats: lastPrice,
      change24hPct: dayOpen !== null && lastPrice !== null && dayOpen > 0
        ? ((lastPrice - dayOpen) / dayOpen) * 100
        : null,
      marketCapSats,
      volume7dSats: weekSats.toString(),
      volume7dChangePct: pct(weekSats, prevWeekSats),
      volume24hSats: sumSats(day).toString(),
      highSats: sales.length ? Math.max(...sales.map((s) => s.unitPriceSats)) : null,
      lowSats: sales.length ? Math.min(...sales.map((s) => s.unitPriceSats)) : null,
      trades: sales.length,
      buyers: new Set(rows.map((r) => r.buyer)).size,
      truncated: rows.length >= SCAN_LIMIT,
      asks,
      recentSales: sales.slice(-RECENT_LIMIT).reverse(),
    });
  } catch (e) {
    return handleError(e);
  }
}
