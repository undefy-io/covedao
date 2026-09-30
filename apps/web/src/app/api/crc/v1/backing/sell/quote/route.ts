import { crcQuoteRoute } from "@/lib/crc-quote-route";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return crcQuoteRoute(req, "sell");
}
