import { ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return ok({ active: false, reason: "CRC marketplace settlement is awaiting token escrow authority" });
}
