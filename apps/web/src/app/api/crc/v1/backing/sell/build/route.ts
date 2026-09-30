import { crcTradeBuildRoute } from "@/lib/crc-trade-build-route";

export const dynamic = "force-dynamic";
export async function POST(req: Request) { return crcTradeBuildRoute(req, "sell"); }
