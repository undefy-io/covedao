import { fail, handleError, ok } from "@/lib/api";
import { parseCrcAssetId, readCrcActivity, readCrcAsset, readCrcCursor } from "@/lib/crc-read";
import { getCrcReadServices } from "@/lib/crc-server";
import { checkCrcRateLimit } from "@/lib/crc-rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const limited = checkCrcRateLimit(req);
    if (limited) return limited;
    const { db, network } = getCrcReadServices();
    const id = parseCrcAssetId((await params).assetId, network);
    if (!id) return fail("TOKEN_NOT_FOUND", "Token not found", 404);
    const indexedTip = await readCrcCursor(db, network);
    if (!indexedTip) return fail("INDEXER_REBUILDING", "Cove CRC index is not ready", 503, true);
    const token = await readCrcAsset(db, network, id.deployTxid);
    if (!token) return fail("TOKEN_NOT_FOUND", "Token not found", 404);
    return ok({ indexedTip, rows: await readCrcActivity(db, network, id.deployTxid) });
  } catch (error) {
    return handleError(error);
  }
}
