import { handleError, ok } from "@/lib/api";
import { readCrcCursor, readCrcRecentActivity } from "@/lib/crc-read";
import { getCrcReadServices } from "@/lib/crc-server";
import { checkCrcRateLimit } from "@/lib/crc-rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const limited = checkCrcRateLimit(req);
    if (limited) return limited;
    const { db, network } = getCrcReadServices();
    const indexedTip = await readCrcCursor(db, network);
    return ok({ network, indexedTip, rows: indexedTip ? await readCrcRecentActivity(db, network) : [] });
  } catch (error) {
    return handleError(error);
  }
}
