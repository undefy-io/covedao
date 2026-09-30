import { fail, handleError, ok } from "@/lib/api";
import { addressToScript } from "@/lib/address";
import { parseCrcWalletCursor, readCrcCursor, readCrcWalletBalances } from "@/lib/crc-read";
import { getCrcReadServices } from "@/lib/crc-server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  try {
    const query = new URL(req.url).searchParams;
    const rawLimit = query.get("limit") ?? "100";
    const limit = Number(rawLimit);
    if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit > 100) {
      return fail("INVALID_PAGINATION", "Limit must be between 1 and 100", 400);
    }
    const rawCursor = query.get("before");
    const before = rawCursor === null ? undefined : parseCrcWalletCursor(rawCursor);
    if (rawCursor !== null && !before) return fail("INVALID_PAGINATION", "Invalid balance cursor", 400);
    const { db, network } = getCrcReadServices();
    const scriptHex = addressToScript((await params).address, network);
    const indexedTip = await readCrcCursor(db, network);
    if (!indexedTip) return fail("INDEXER_REBUILDING", "Cove CRC index is not ready", 503, true);
    const rows = await readCrcWalletBalances(db, network, scriptHex, limit + 1, before ?? undefined);
    const balances = rows.slice(0, limit);
    const last = balances.at(-1);
    return ok({
      network, indexedTip, address: (await params).address, balances,
      nextCursor: rows.length > limit && last ? `${last.atoms}:${last.assetId.split(":")[1]}` : null,
    });
  } catch (error) {
    return handleError(error);
  }
}
