import { handleError, ok } from "@/lib/api";
import { readCrcCursor } from "@/lib/crc-read";
import { getCrcReadServices } from "@/lib/crc-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { db, network } = getCrcReadServices();
    return ok({ network, indexedTip: await readCrcCursor(db, network) });
  } catch (error) {
    return handleError(error);
  }
}
