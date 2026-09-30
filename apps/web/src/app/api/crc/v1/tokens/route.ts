import { fail, handleError, ok } from "@/lib/api";
import { listCrcAssets, parseCrcPageCursor, readCrcCursor } from "@/lib/crc-read";
import { getCrcReadServices } from "@/lib/crc-server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const query = new URL(req.url).searchParams;
    const rawLimit = query.get("limit") ?? "50";
    const limit = Number(rawLimit);
    if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit > 100) {
      return fail("INVALID_PAGINATION", "Limit must be between 1 and 100", 400);
    }
    const rawCursor = query.get("before");
    const before = rawCursor === null ? undefined : parseCrcPageCursor(rawCursor);
    if (rawCursor !== null && !before) return fail("INVALID_PAGINATION", "Invalid catalog cursor", 400);
    const { db, network } = getCrcReadServices();
    const indexedTip = await readCrcCursor(db, network);
    if (!indexedTip) return fail("INDEXER_REBUILDING", "Cove CRC index is not ready", 503, true);
    const rows = await listCrcAssets(db, network, limit + 1, before ?? undefined);
    const tokens = rows.slice(0, limit);
    const last = tokens.at(-1);
    return ok({
      network, indexedTip, tokens,
      nextCursor: rows.length > limit && last ? `${last.deployHeight}:${last.deployTxid}` : null,
    });
  } catch (error) {
    return handleError(error);
  }
}
