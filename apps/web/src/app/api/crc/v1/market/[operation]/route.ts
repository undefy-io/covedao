import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST() {
  return fail("CRC_MARKET_DISABLED", "Cove marketplace trading is paused until v2 token outpoint release tests pass.", 503, true);
}
