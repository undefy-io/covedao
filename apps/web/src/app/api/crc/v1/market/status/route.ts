import { ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return ok({ active: false, reason: "CRC marketplace is awaiting v2 token outpoint release tests" });
}
