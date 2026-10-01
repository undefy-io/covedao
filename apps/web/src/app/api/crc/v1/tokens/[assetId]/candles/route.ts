import { bucketTrades, BUCKET_MS, type Interval } from "@/lib/ohlc";
import { fail, handleError, ok } from "@/lib/api";
import { parseCrcAssetId, readCrcCursor, readCrcTrades } from "@/lib/crc-read";
import { getCrcReadServices } from "@/lib/crc-server";
import { checkCrcRateLimit } from "@/lib/crc-rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const limited = checkCrcRateLimit(req);
    if (limited) return limited;
    const interval = new URL(req.url).searchParams.get("interval") ?? "1h";
    if (!(interval in BUCKET_MS)) return fail("BAD_REQUEST", "Unsupported candle interval", 400);
    const { db, network } = getCrcReadServices();
    const id = parseCrcAssetId((await params).assetId, network);
    if (!id) return fail("TOKEN_NOT_FOUND", "Token not found", 404);
    const indexedTip = await readCrcCursor(db, network);
    if (!indexedTip) return fail("INDEXER_REBUILDING", "Cove CRC index is not ready", 503, true);
    const rows = await readCrcTrades(db, network, id.deployTxid);
    const width = BUCKET_MS[interval as Interval];
    const newest = rows.at(-1)?.timestamp ?? 0;
    const windowed = rows.filter((row) => row.timestamp >= newest - width * 499);
    return ok({ indexedTip, candles: bucketTrades(windowed, interval as Interval), tradeCount: windowed.length });
  } catch (error) {
    return handleError(error);
  }
}
