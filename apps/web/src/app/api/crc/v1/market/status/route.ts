import { ok } from "@/lib/api";
import { isCrcMarketReleased } from "@/lib/crc-market-availability";

export const dynamic = "force-dynamic";

export async function GET() {
  const active = isCrcMarketReleased();
  return ok({ active, reason: active ? null : "CRC marketplace is awaiting token outpoint release tests" });
}
